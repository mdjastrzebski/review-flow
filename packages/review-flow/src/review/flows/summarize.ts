import type { FlowContext } from "../../runtime/flow.ts";
import type { RoleModels } from "../models.ts";
import { loadPrompt } from "../prompts.ts";
import { RUN_FILES } from "../run-dir.ts";
import { Summary } from "../schemas.ts";
import {
  buildSummarizerPrompt,
  normalizeSummary,
  type Intent,
  type SummaryOutcome,
} from "../summary.ts";
import type { TrustLevel } from "../trust.ts";
import type { ChangeRange } from "../verify.ts";

const SUMMARIZER_TIMEOUT_MS = 10 * 60 * 1000;

export interface SummarizeInput {
  /** The checkout agents read. */
  repo: string;
  change: ChangeRange;
  sharedContext: string;
  intent: Intent;
  models: Pick<RoleModels, "summarizer">;
  trust: TrustLevel;
  /** The summary, as soon as it is written. */
  onSummary: (summary: Summary, trust: TrustLevel) => void;
}

/**
 * One summarizer session. An agent failure leaves the run without a summary instead of failing it;
 * anything thrown (e.g. the working tree changed) stops the run.
 */
export async function summarize(input: SummarizeInput, ctx: FlowContext): Promise<SummaryOutcome> {
  const { model, effort } = input.models.summarizer;
  ctx.log("Summarizing…");
  const result = await ctx.agent({
    taskId: "summarizer",
    role: "summarizer",
    prompt: buildSummarizerPrompt(await loadPrompt("summarizer"), input.change, input.intent),
    sharedContext: input.sharedContext,
    cwd: input.repo,
    schema: Summary,
    model,
    effort,
    timeoutMs: SUMMARIZER_TIMEOUT_MS,
  });
  if (result.output === null) {
    const error = `${result.status}: ${result.error ?? "no output"}`;
    ctx.warn(`Summarizer failed (${error}); the report has no summary.`);
    return { status: "failed", error };
  }
  const summary = normalizeSummary(result.output, input.repo);
  await ctx.write(RUN_FILES.summary, summary);
  input.onSummary(summary, input.trust);
  return { status: "ok", summary };
}
