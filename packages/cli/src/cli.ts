import { Command, Option } from "commander";
import { getAgent } from "@review-flow/agents";
import {
  EFFORTS,
  HARNESSES,
  NoChangesError,
  loadRun,
  readIndex,
  resolveModels,
  resolveRepoRoot,
  resolveRun,
  runReview,
  type Effort,
  type Harness,
} from "@review-flow/core";
import { formatFindings } from "./format.ts";
import { formatCompare, formatRuns } from "./runs.ts";

// pnpm runs scripts from the workspace root; INIT_CWD is where the user ran the command.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const colorOptions = () => ({ color: process.stdout.hasColors?.() ?? false });

interface ReviewOptions {
  base: string;
  harness: Harness;
  model?: string;
  verifierModel?: string;
  effort?: Effort;
  verifierEffort?: Effort;
  claudeBin: string;
  cursorBin: string;
  repo: string;
  quiet: boolean;
}

async function review(options: ReviewOptions): Promise<void> {
  const models = resolveModels(options.harness, {
    model: options.model ?? null,
    verifierModel: options.verifierModel ?? null,
    effort: options.effort ?? null,
    verifierEffort: options.verifierEffort ?? null,
  });
  const log = options.quiet ? () => {} : (message: string) => console.log(message);

  let result;
  try {
    result = await runReview({
      cwd: options.repo,
      base: options.base,
      harness: options.harness,
      models,
      runAgent: getAgent(options.harness, {
        claudeBin: options.claudeBin,
        cursorBin: options.cursorBin,
      }),
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
  console.log(formatCompare(runA!, runB!, colorOptions()));
}

const program = new Command("review-flow");

program
  .command("review")
  .description("Review the current branch against a base ref")
  .requiredOption("--base <ref>", "base ref to diff against (merge-base...HEAD)")
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
  .option("--cursor-bin <path>", "Cursor agent CLI binary", "agent")
  .option("--repo <path>", "repository to review", userCwd)
  .option("-q, --quiet", "no progress or findings output; print only the run dir path", false)
  .action(review);

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
