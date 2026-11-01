import { Command, Option } from "commander";
import { getAgent } from "@review-flow/agents";
import {
  EFFORTS,
  HARNESSES,
  NoChangesError,
  resolveModels,
  runReview,
  type Effort,
  type Harness,
} from "@review-flow/core";
import { formatFindings } from "./format.ts";

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
  .option("--repo <path>", "repository to review", process.env.INIT_CWD ?? process.cwd())
  .option("-q, --quiet", "no progress or findings output; print only the run dir path", false)
  .action(review);

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
