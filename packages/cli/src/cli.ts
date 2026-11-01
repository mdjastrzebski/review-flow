import { Command, Option } from "commander";
import { getAgent } from "@review-flow/agents";
import {
  DEFAULT_DATASET_DIR,
  EFFORTS,
  HARNESSES,
  NoChangesError,
  defaultCheckoutsDir,
  loadDataset,
  loadRun,
  readIndex,
  resolveModels,
  resolveRepoRoot,
  resolveRun,
  runEval,
  runReview,
  type Effort,
  type Harness,
} from "@review-flow/core";
import path from "node:path";
import { formatFindings } from "./format.ts";
import { formatCompare, formatEval, formatEvalCompare, formatRuns } from "./runs.ts";

// pnpm runs scripts from the workspace root; INIT_CWD is where the user ran the command.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const colorOptions = () => ({ color: process.stdout.hasColors?.() ?? false });

interface AgentOptions {
  harness: Harness;
  model?: string;
  verifierModel?: string;
  effort?: Effort;
  verifierEffort?: Effort;
  claudeBin: string;
  cursorBin: string;
}

function resolveAgent(options: AgentOptions) {
  return {
    harness: options.harness,
    models: resolveModels(options.harness, {
      model: options.model ?? null,
      verifierModel: options.verifierModel ?? null,
      effort: options.effort ?? null,
      verifierEffort: options.verifierEffort ?? null,
    }),
    runAgent: getAgent(options.harness, {
      claudeBin: options.claudeBin,
      cursorBin: options.cursorBin,
    }),
  };
}

/** Harness, model, effort, and binary options, shared by review and eval. */
function addAgentOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--harness <name>", "agent harness").choices(HARNESSES).makeOptionMandatory(),
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
  base: string;
  repo: string;
  quiet: boolean;
}

async function review(options: ReviewOptions): Promise<void> {
  const log = options.quiet ? () => {} : (message: string) => console.log(message);

  let result;
  try {
    result = await runReview({
      ...resolveAgent(options),
      cwd: options.repo,
      base: options.base,
      log,
    });
  } catch (error) {
    if (!(error instanceof NoChangesError)) throw error;
    // Nothing to review is a clean exit; stderr keeps --quiet's stdout empty (no run dir).
    console.error(`Nothing to review: no changes between ${error.base} and HEAD.`);
    return;
  }

  if (options.quiet) {
    // Only the run dir, so scripts can do: R=$(review-flow review --quiet ...)
    console.log(result.runDir.root);
    return;
  }
  console.log(
    formatFindings(
      { ...result, base: options.base, reportPath: result.runDir.reportPath },
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
  const dataset = path.resolve(userCwd, options.dataset);
  const result = await runEval({
    ...resolveAgent(options),
    cwd: options.repo,
    cases: await loadDataset(dataset, { smoke: options.smoke, ids: options.case ?? [] }),
    dataset,
    smoke: options.smoke,
    checkoutsDir: path.resolve(userCwd, options.checkouts),
    log: options.quiet ? () => {} : (message: string) => console.log(message),
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
    .requiredOption("--base <ref>", "base ref to diff against (merge-base...HEAD)"),
)
  .option("--repo <path>", "repository to review", userCwd)
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
