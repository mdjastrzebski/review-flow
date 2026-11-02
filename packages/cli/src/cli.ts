import { Command, Option } from "commander";
import { getAgent } from "@review-flow/agents";
import {
  DEFAULT_DATASET_DIR,
  EFFORTS,
  HARNESSES,
  NoChangesError,
  defaultBase,
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
} from "@review-flow/core";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { formatFindings } from "./format.ts";
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

const interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** Asks on stderr so stdout stays clean for --quiet. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

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

async function review(options: ReviewOptions): Promise<void> {
  const log: Log = options.quiet ? () => {} : (message: string) => console.log(message);
  const agent = await resolveAgent(options, log);
  const base = options.base ?? (await askBase(options.repo, log));

  let result;
  try {
    result = await runReview({
      ...agent,
      cwd: options.repo,
      base,
      committedOnly: options.committedOnly,
      log,
    });
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
      { ...result, base, reportPath: result.runDir.reportPath },
      {
        color: process.stdout.hasColors?.() ?? false,
        width: Math.min(process.stdout.columns ?? 100, 100),
      },
    ),
  );
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

const program = new Command("review-flow");

addAgentOptions(
  program
    .command("review")
    .description("Review the current branch against a base ref")
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
