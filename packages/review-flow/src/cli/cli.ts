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
import { formatFindings, formatSummary } from "./format.ts";
import { postRun } from "./post.ts";
import { createProgress, type Progress } from "./progress.ts";
import { ask, choose, confirm, interactive, note } from "./prompt.ts";
import { formatCompare, formatEval, formatEvalCompare, formatRuns } from "./runs.ts";

// pnpm runs scripts from the workspace root; INIT_CWD is where the user ran the command.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const colorOptions = () => ({ color: process.stdout.hasColors?.() ?? false });

interface AgentOptions {
  harness?: Harness;
  model?: string;
  verifierModel?: string;
  summarizerModel?: string;
  effort?: Effort;
  verifierEffort?: Effort;
  summarizerEffort?: Effort;
  claudeBin: string;
  cursorBin: string;
}

type Log = (message: string) => void;

/** The pipeline's progress hooks. */
const progressHooks = (progress: Progress) => ({
  log: progress.log,
  warn: progress.warn,
  logTable: progress.logTable,
  ...(progress.onActivity === undefined ? {} : { onActivity: progress.onActivity }),
  ...(progress.onSummary === undefined ? {} : { onSummary: progress.onSummary }),
});

/** --harness, else the saved one, else asked in a TTY and saved for next time. */
async function resolveHarness(flag: Harness | undefined): Promise<Harness> {
  if (flag !== undefined) return flag;
  const saved = (await readUserConfig()).harness;
  if (saved !== undefined) return saved;
  if (!interactive()) throw new Error(`No harness set. Pass --harness (${HARNESSES.join(", ")}).`);
  const harness = await choose("Harness", HARNESSES, "claude");
  if (harness === null) throw new Error("No harness chosen.");
  await saveUserHarness(harness);
  note.info(`Saved to ${userConfigPath()}; --harness overrides it.`);
  return harness;
}

async function resolveAgent(options: AgentOptions) {
  const harness = await resolveHarness(options.harness);
  return {
    harness,
    models: resolveModels(harness, {
      model: options.model ?? null,
      verifierModel: options.verifierModel ?? null,
      summarizerModel: options.summarizerModel ?? null,
      effort: options.effort ?? null,
      verifierEffort: options.verifierEffort ?? null,
      summarizerEffort: options.summarizerEffort ?? null,
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
    .option(
      "--model <id>",
      "model for every role (summarizer, reviewer, verifier), unless overridden",
    )
    .option("--verifier-model <id>", "model for the verifiers")
    .option("--summarizer-model <id>", "model for the summarizer")
    .addOption(
      new Option("--effort <level>", "effort for every role, unless overridden").choices(EFFORTS),
    )
    .addOption(new Option("--verifier-effort <level>", "effort for the verifiers").choices(EFFORTS))
    .addOption(
      new Option("--summarizer-effort <level>", "effort for the summarizer").choices(EFFORTS),
    )
    .option("--claude-bin <path>", "Claude Code CLI binary", "claude")
    .option("--cursor-bin <path>", "Cursor agent CLI binary", "agent");
}

const verboseOption = () =>
  new Option(
    "-v, --verbose",
    "more progress detail: agent commands, sessions and text, tokens per call, step times",
  )
    .default(false)
    .conflicts("quiet");

interface ReviewOptions extends AgentOptions {
  base?: string;
  /** false with --no-summary. */
  summary: boolean;
  /** false for `review-flow summary`. */
  find: boolean;
  committedOnly: boolean;
  repo: string;
  quiet: boolean;
  verbose: boolean;
}

/** The default base, fetched from origin; in a TTY the user can confirm or replace it. */
async function askBase(repo: string, log: Log): Promise<string> {
  log("No --base given; fetching the default branch from origin...");
  const { ref, warning } = await defaultBase(repo);
  if (warning !== null) note.warn(warning);
  if (!interactive()) return ref;
  const base = await ask("Base", ref);
  if (base === null) throw new Error("No base chosen.");
  return base;
}

/**
 * Fetches the PR, checks out its head in a temporary worktree, and reviews it there against the
 * PR's base. The worktree is removed afterwards, also on Ctrl-C.
 */
async function reviewPr(
  target: string,
  agent: Awaited<ReturnType<typeof resolveAgent>>,
  options: ReviewOptions,
  progress: Progress,
) {
  const { log } = progress;
  if (options.base !== undefined) throw new Error("--base can't be used with a PR target.");
  const repo = await resolveRepoRoot(options.repo);
  log(`Fetching PR ${target}...`);
  const { pr, body, base } = await fetchPr(repo, target);
  progress.logTable(`PR #${pr.number}`, [
    ["Title", pr.title],
    ["Base", base],
    ["Head", pr.headSha.slice(0, 7)],
    ...(pr.isCrossRepository ? [["Fork", "yes; reviewed as trusted code"] as const] : []),
  ]);

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
      prBody: body,
      base,
      committedOnly: true,
      summarize: options.summary,
      find: options.find,
      ...progressHooks(progress),
      verbose: options.verbose,
    });
    return { ...result, base };
  } finally {
    process.off("SIGINT", onSigint);
    await worktree.remove();
  }
}

async function review(target: string | undefined, options: ReviewOptions): Promise<void> {
  const progress = createProgress({ quiet: options.quiet, verbose: options.verbose, cwd: userCwd });
  const prTarget = target === undefined ? null : parsePrTarget(target);
  if (target !== undefined && prTarget === null) {
    throw new Error(
      `Unsupported target "${target}". Only PR numbers and URLs are supported so far.`,
    );
  }
  let result;
  try {
    const agent = await resolveAgent(options);
    if (prTarget !== null) {
      result = await reviewPr(prTarget, agent, options, progress);
    } else {
      const base = options.base ?? (await askBase(options.repo, progress.log));
      result = {
        ...(await runReview({
          ...agent,
          cwd: options.repo,
          base,
          committedOnly: options.committedOnly,
          summarize: options.summary,
          find: options.find,
          ...progressHooks(progress),
          verbose: options.verbose,
        })),
        base,
      };
    }
  } catch (error) {
    progress.end();
    if (!(error instanceof NoChangesError)) throw error;
    // Nothing to review is a clean exit; stderr keeps --quiet's stdout empty (no run dir).
    note.info(`Nothing to review: ${error.message}`);
    return;
  }
  progress.end();

  if (options.quiet) {
    // Only the run dir, so scripts can do: R=$(review-flow review --quiet ...)
    console.log(result.runDir.root);
    return;
  }
  const format = { ...colorOptions(), width: Math.min(process.stdout.columns ?? 100, 100) };
  // A live display already showed the summary (or warned that it failed) during the run.
  if (result.summary !== null && progress.onSummary === undefined) {
    console.log(formatSummary(result.summary, format));
  }
  if (!options.find) {
    console.log(`\nReport: ${result.runDir.reportPath}\n`);
    return;
  }
  console.log(formatFindings({ ...result, reportPath: result.runDir.reportPath }, format));

  if (prTarget !== null && interactive()) {
    const postable =
      result.summary?.status === "ok" || postableItems(result.findings, result.verdicts).length > 0;
    if (postable && (await confirm("Post to the PR?"))) {
      await postRun(result.runDir.root, colorOptions());
    } else if (postable) {
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
  summary: boolean;
  case?: string[];
  dataset: string;
  checkouts: string;
  repo: string;
  quiet: boolean;
  verbose: boolean;
}

async function evaluate(options: EvalOptions): Promise<void> {
  const progress = createProgress({ quiet: options.quiet, verbose: options.verbose, cwd: userCwd });
  const dataset = path.resolve(userCwd, options.dataset);
  let result;
  try {
    result = await runEval({
      ...(await resolveAgent(options)),
      cwd: options.repo,
      cases: await loadDataset(dataset, { smoke: options.smoke, ids: options.case ?? [] }),
      dataset,
      smoke: options.smoke,
      summarize: options.summary,
      checkoutsDir: path.resolve(userCwd, options.checkouts),
      ...progressHooks(progress),
      verbose: options.verbose,
    });
  } finally {
    progress.end();
  }
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

/** Target, base, and output options, shared by review and summary. */
function addTargetOptions(command: Command): Command {
  return addAgentOptions(
    command
      .argument("[target]", "PR number or URL; default: the current branch")
      .option(
        "-b, --base <ref>",
        "base ref to diff against (merge-base...HEAD); default: origin/main, fetched, confirmed in a TTY",
      ),
  )
    .option("--repo <path>", "repository to review", userCwd)
    .option("--committed-only", "review HEAD only, without uncommitted changes", false)
    .option("-q, --quiet", "no progress or other output; print only the run dir path", false)
    .addOption(verboseOption());
}

addTargetOptions(
  program
    .command("review", { isDefault: true })
    .description("Review the current branch, or a PR, against a base ref"),
)
  .option("--no-summary", "skip the summary of the change")
  .action((target: string | undefined, options: Omit<ReviewOptions, "find">) =>
    review(target, { ...options, find: true }),
  );

addTargetOptions(
  program
    .command("summary")
    .description("Summarize the current branch, or a PR, without looking for defects"),
).action((target: string | undefined, options: Omit<ReviewOptions, "find" | "summary">) =>
  review(target, { ...options, summary: true, find: false }),
);

addAgentOptions(
  program
    .command("eval")
    .description("Review every case of the eval dataset and score the findings")
    .option("--smoke", "only the smoke set", false)
    .option("--no-summary", "skip the summary of each case")
    .option("--case <ids...>", "only these cases (ids, as in eval/cases/<id>.json)"),
)
  .option("--dataset <dir>", "dir of case files", DEFAULT_DATASET_DIR)
  .option("--checkouts <dir>", "where case repos are cloned and kept", defaultCheckoutsDir())
  .option("--repo <path>", "repository to save the eval run in", userCwd)
  .option("-q, --quiet", "no progress or summary output; print only the eval run dir path", false)
  .addOption(verboseOption())
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
