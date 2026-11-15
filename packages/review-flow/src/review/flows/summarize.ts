import { describeFailure } from "../../runtime/agent.ts";
import type { FlowContext } from "../../runtime/flow.ts";
import { RUN_FILES } from "../run-dir.ts";
import { Summary } from "../schemas.ts";
import { renderPrompt } from "../prompts.ts";
import { describeIntent, normalizeSummary, type Intent, type SummaryOutcome } from "../summary.ts";
import { runRole, type ReviewScope } from "./scope.ts";

export interface SummarizeInput {
  scope: ReviewScope;
  intent: Intent;
  /** The summary, as soon as it is written. Default: a `Summary written` line. */
  onSummary?: ((summary: Summary) => void) | undefined;
}

/**
 * One summarizer session. An agent failure leaves the run without a summary instead of failing it;
 * anything thrown (e.g. the working tree changed) stops the run.
 */
export async function summarize(input: SummarizeInput, ctx: FlowContext): Promise<SummaryOutcome> {
  const { scope } = input;
  ctx.log("Summarizing…");
  const result = await runRole(ctx, scope, "summarizer", {
    taskId: "summarizer",
    prompt: renderPrompt("summarizer", { ...scope.change, intent: describeIntent(input.intent) }),
    schema: Summary,
  });
  if (result.status === "failure") {
    const error = describeFailure(result);
    ctx.warn(`Summarizer failed (${error}); the report has no summary.`);
    return { status: "failed", error };
  }
  const summary = normalizeSummary(result.output, scope.repo);
  await ctx.writeFile(RUN_FILES.summary, summary);
  if (input.onSummary === undefined) ctx.log("Summary written");
  else input.onSummary(summary);
  return { status: "ok", summary };
}
