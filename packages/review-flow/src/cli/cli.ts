#!/usr/bin/env node
import { Command, Option } from "commander";
import { getAgent } from "../agents/index.ts";
import {
  DEFAULT_DATASET_DIR,
  EFFORTS,
  HARNESSES,
  NoChangesError,
  createReviewWorktree,
  defaultBase,
  ensureStateDir,
  fetchPr,
  parsePrTarget,
  postableItems,
  defaultCheckoutsDir,
  loadDataset,
  loadRun,
  readIndex,
  readUserConfig,
  resolveModels,
  resolveRepoRoot,
  resolveRun,
  runEval,
  runReview,
  saveUserHarness,
  userConfigPath,
  type Effort,
  type Harness,
} from "../core/index.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatFindings } from "./format.ts";
import { postRun } from "./post.ts";
import { ask, confirm, interactive } from "./prompt.ts";
import { formatCompare, formatEval, formatEvalCompare, formatRuns } from "./runs.ts";

// pnpm runs scripts from the workspace root; INIT_CWD is where the user ran the command.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const colorOptions = () => ({ color: process.stdout.hasColors?.() ?? false });

interface AgentOptions {
  harness?: Harness;
  model?: string;
  verifierModel?: string;
  effort?: Effort;
  verifierEffort?: Effort;
  claudeBin: string;
  cursorBin: string;
}

type Log = (message: string) => void;

/** --harness, else the saved one, else asked in a TTY and saved for next time. */
async function resolveHarness(flag: Harness | undefined, log: Log): Promise<Harness> {
  if (flag !== undefined) return flag;
  const saved = (await readUserConfig()).harness;
  if (saved !== undefined) {
    log(`Harness: ${saved} (from ${userConfigPath()})`);
    return saved;
  }
  const choices = HARNESSES.join(", ");
  if (!interactive()) throw new Error(`No harness set. Pass --harness (${choices}).`);
  const fallback: Harness = "claude";
  for (;;) {
    const answer = (await ask(`Harness (${choices}) [${fallback}]: `)) || fallback;
    const harness = HARNESSES.find((name) => name === answer);
    if (harness === undefined) {
      console.error(`Unknown harness: ${answer}`);
      continue;
    }
    await saveUserHarness(harness);
    console.error(`Saved to ${userConfigPath()}; --harness overrides it.`);
    return harness;
  }
}

async function resolveAgent(options: AgentOptions, log: Log) {
  const harness = await resolveHarness(options.harness, log);
  return {
    harness,
    models: resolveModels(harness, {
      model: options.model ?? null,
      verifierModel: options.verifierModel ?? null,
      effort: options.effort ?? null,
      verifierEffort: options.verifierEffort ?? null,
    }),
    runAgent: getAgent(harness, {
      claudeBin: options.claudeBin,
      cursorBin: options.cursorBin,
    }),
  };
}

/** Harness, model, effort, and binary options, shared by review and eval. */
function addAgentOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        "-H, --harness <name>",
        "agent harness; default: the one saved in the user config, asked for in a TTY",
      ).choices(HARNESSES),
    )
    .option("--model <id>", "model for the reviewer (and verifier, unless overridden)")
    .option("--verifier-model <id>", "model for the verifiers")
    .addOption(
      new Option(
        "--effort <level>",
        "effort for the reviewer (and verifier, unless overridden)",
      ).choices(EFFORTS),
    )
    .addOption(new Option("--verifier-effort <level>", "effort for the verifiers").choices(EFFORTS))
    .option("--claude-bin <path>", "Claude Code CLI binary", "claude")
    .option("--cursor-bin <path>", "Cursor agent CLI binary", "agent");
}

interface ReviewOptions extends AgentOptions {
  base?: string;
  committedOnly: boolean;
  repo: string;
  quiet: boolean;
}

/** The default base, fetched from origin; in a TTY the user can confirm or replace it. */
async function askBase(repo: string, log: Log): Promise<string> {
  log("No --base given; fetching the default branch from origin...");
  const { ref, warning } = await defaultBase(repo);
  if (warning !== null) console.error(warning);
  if (!interactive()) return ref;
  return (await ask(`Base [${ref}]: `)) || ref;
}

/**
 * Fetches the PR, checks out its head in a temporary worktree, and reviews it there against the
 * PR's base. The worktree is removed afterwards, also on Ctrl-C.
 */
async function reviewPr(
  target: string,
  agent: Awaited<ReturnType<typeof resolveAgent>>,
  options: ReviewOptions,
  log: Log,
) {
  if (options.base !== undefined) throw new Error("--base can't be used with a PR target.");
  const repo = await resolveRepoRoot(options.repo);
  log(`Fetching PR ${target}...`);
  const { pr, base } = await fetchPr(repo, target);
  log(`PR #${pr.number}: ${pr.title}`);
  log(`Base: ${base} · Head: ${pr.headSha.slice(0, 7)}`);
  if (pr.isCrossRepository) log("PR is from a fork; it is reviewed as trusted code.");

  await ensureStateDir(repo);
  const worktree = await createReviewWorktree(repo, pr.headSha);
  const onSigint = () => {
    worktree.removeSync();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    const result = await runReview({
      ...agent,
      cwd: worktree.dir,
      stateRepo: repo,
      pr,
      base,
      committedOnly: true,
      log,
    });
    return { ...result, base };
  } finally {
    process.off("SIGINT", onSigint);
    await worktree.remove();
  }
}

async function review(target: string | undefined, options: ReviewOptions): Promise<void> {
  const log: Log = options.quiet ? () => {} : (message: string) => console.log(message);
  const prTarget = target === undefined ? null : parsePrTarget(target);
  if (target !== undefined && prTarget === null) {
    throw new Error(
      `Unsupported target "${target}". Only PR numbers and URLs are supported so far.`,
    );
  }
  const agent = await resolveAgent(options, log);

  let result;
  try {
    if (prTarget !== null) {
      result = await reviewPr(prTarget, agent, options, log);
    } else {
      const base = options.base ?? (await askBase(options.repo, log));
      result = {
        ...(await runReview({
          ...agent,
          cwd: options.repo,
          base,
          committedOnly: options.committedOnly,
          log,
        })),
        base,
      };
    }
  } catch (error) {
    if (!(error instanceof NoChangesError)) throw error;
    // Nothing to review is a clean exit; stderr keeps --quiet's stdout empty (no run dir).
    console.error(`Nothing to review: ${error.message}`);
    return;
  }

  if (options.quiet) {
    // Only the run dir, so scripts can do: R=$(review-flow review --quiet ...)
    console.log(result.runDir.root);
    return;
  }
  console.log(
    formatFindings(
      { ...result, reportPath: result.runDir.reportPath },
      {
        color: process.stdout.hasColors?.() ?? false,
        width: Math.min(process.stdout.columns ?? 100, 100),
      },
    ),
  );

  if (prTarget !== null && interactive()) {
    const postable = postableItems(result.findings, result.verdicts);
    if (postable.length > 0 && (await confirm("Post findings to the PR?"))) {
      await postRun(result.runDir.root, colorOptions());
    } else if (postable.length > 0) {
      console.log(`Post later with: review-flow post ${path.basename(result.runDir.root)}`);
    }
  }
}

async function post(ref: string | undefined, options: { repo: string }): Promise<void> {
  const repo = await resolveRepoRoot(options.repo);
  let id = ref;
  if (id === undefined) {
    const latest = (await readIndex(repo)).findLast(
      (e) => e.kind === "review" && e.pr !== undefined,
    );
    if (latest === undefined) throw new Error("No PR review to post. Review a PR first.");
    id = latest.id;
  }
  await postRun((await resolveRun(repo, id, userCwd)).root, colorOptions());
}

interface EvalOptions extends AgentOptions {
  smoke: boolean;
  case?: string[];
  dataset: string;
  checkouts: string;
  repo: string;
  quiet: boolean;
}

async function evaluate(options: EvalOptions): Promise<void> {
  const log: Log = options.quiet ? () => {} : (message: string) => console.log(message);
  const dataset = path.resolve(userCwd, options.dataset);
  const result = await runEval({
    ...(await resolveAgent(options, log)),
    cwd: options.repo,
    cases: await loadDataset(dataset, { smoke: options.smoke, ids: options.case ?? [] }),
    dataset,
    smoke: options.smoke,
    checkoutsDir: path.resolve(userCwd, options.checkouts),
    log,
  });
  // Like review: --quiet prints only the run dir.
  console.log(options.quiet ? result.root : `\n${formatEval(result, colorOptions())}`);
}

async function runs(options: { repo: string; limit: string }): Promise<void> {
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const entries = await readIndex(await resolveRepoRoot(options.repo));
  console.log(formatRuns(entries.slice(-limit), colorOptions()));
}

async function compare(a: string, b: string, options: { repo: string }): Promise<void> {
  const repo = await resolveRepoRoot(options.repo);
  const [runA, runB] = await Promise.all(
    [a, b].map(async (ref) => loadRun((await resolveRun(repo, ref, userCwd)).root)),
  );
  if (runA?.kind === "eval" && runB?.kind === "eval") {
    console.log(formatEvalCompare(runA, runB, colorOptions()));
  } else if (runA?.kind === "review" && runB?.kind === "review") {
    console.log(formatCompare(runA, runB, colorOptions()));
  } else {
    throw new Error("Can't compare a review run with an eval run.");
  }
}

// The package.json at the package root, from both src/cli/ and dist/cli/.
const { version } = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command("review-flow").version(version);

addAgentOptions(
  program
    .command("review", { isDefault: true })
    .description("Review the current branch, or a PR, against a base ref")
    .argument("[target]", "PR number or URL; default: the current branch")
    .option(
      "-b, --base <ref>",
      "base ref to diff against (merge-base...HEAD); default: origin/main, fetched, confirmed in a TTY",
    ),
)
  .option("--repo <path>", "repository to review", userCwd)
  .option("--committed-only", "review HEAD only, without uncommitted changes", false)
  .option("-q, --quiet", "no progress or findings output; print only the run dir path", false)
  .action(review);

addAgentOptions(
  program
    .command("eval")
    .description("Review every case of the eval dataset and score the findings")
    .option("--smoke", "only the smoke set", false)
    .option("--case <ids...>", "only these cases (ids, as in eval/cases/<id>.json)"),
)
  .option("--dataset <dir>", "dir of case files", DEFAULT_DATASET_DIR)
  .option("--checkouts <dir>", "where case repos are cloned and kept", defaultCheckoutsDir())
  .option("--repo <path>", "repository to save the eval run in", userCwd)
  .option("-q, --quiet", "no progress or summary output; print only the eval run dir path", false)
  .action(evaluate);

program
  .command("post")
  .description("Post selected findings of a PR review as a GitHub review comment")
  .argument(
    "[run]",
    "run id, a unique part of one, or a run dir path; default: the latest PR review",
  )
  .option("--repo <path>", "repository", userCwd)
  .action(post);

program
  .command("runs")
  .description("List past runs, newest first")
  .option("-n, --limit <count>", "how many runs to show", "20")
  .option("--repo <path>", "repository", userCwd)
  .action(runs);

program
  .command("compare")
  .description("Compare two runs: cost and time per step, and which findings differ")
  .argument("<a>", "run id, a unique part of one (such as the short SHA), or a run dir path")
  .argument("<b>", "the run to compare against A")
  .option("--repo <path>", "repository", userCwd)
  .action(compare);

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
