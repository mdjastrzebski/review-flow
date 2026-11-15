import type { z } from "zod";
import type { AgentResult } from "../../runtime/agent.ts";
import type { FlowContext } from "../../runtime/flow.ts";
import type { CallRecord } from "../../runtime/records.ts";
import type { ReviewRole, RoleModels } from "../models.ts";
import type { ChangeRange } from "../verify.ts";

/** What every review agent works on: one change in one checkout. */
export interface ReviewScope {
  /** The checkout agents read. */
  repo: string;
  change: ChangeRange;
  /** The change context (diff and range) shared by a run's tasks; see AgentTask.sharedContext. */
  sharedContext: string;
  models: RoleModels;
}

export interface RoleTask<T> {
  taskId: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Default: the scope's. */
  sharedContext?: string | null;
}

/** One agent call for `role`, on the scope's checkout with the role's model and timeout. */
export function runRole<T>(
  ctx: FlowContext,
  scope: ReviewScope,
  role: ReviewRole,
  task: RoleTask<T>,
): Promise<AgentResult<T> & { call: CallRecord }> {
  const { model, effort } = scope.models[role];
  return ctx.agent({
    sharedContext: scope.sharedContext,
    ...task,
    role,
    cwd: scope.repo,
    model,
    effort,
    timeoutMs: TIMEOUTS_MS[role],
  });
}

const TIMEOUTS_MS: Record<ReviewRole, number> = {
  summarizer: 10 * 60 * 1000,
  reviewer: 20 * 60 * 1000,
  verifier: 10 * 60 * 1000,
};
