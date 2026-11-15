import { defineFlow } from "../../runtime/flow.ts";
import type { RoleModels } from "../models.ts";
import { loadPrompt } from "../prompts.ts";
import {
  ROUGH_EDGE_CHECKER_TASK_ID,
  applyChecks,
  buildRoughEdgeCheckerPrompt,
} from "../rough-edges.ts";
import { RoughEdgeChecks, type CheckedRoughEdge, type NormalizedRoughEdge } from "../schemas.ts";
import type { ChangeRange } from "../verify.ts";
import { VERIFIER_TIMEOUT_MS } from "./verify.ts";

export interface CheckRoughEdgesInput {
  repo: string;
  edges: readonly NormalizedRoughEdge[];
  change: ChangeRange;
  sharedContext: string;
  models: Pick<RoleModels, "verifier">;
}

/**
 * One batched checker session for all rough edges, on the verifier's model. It runs after the
 * finding verifiers so the shared diff is already cached. A failed or incomplete answer leaves
 * the edges `unclear`; anything thrown stops the run.
 */
export const checkRoughEdgesFlow = defineFlow(
  "check",
  async (input: CheckRoughEdgesInput, ctx): Promise<CheckedRoughEdge[]> => {
    const { edges } = input;
    const result = await ctx.agent({
      taskId: ROUGH_EDGE_CHECKER_TASK_ID,
      role: "verifier",
      prompt: buildRoughEdgeCheckerPrompt(
        await loadPrompt("rough-edge-checker"),
        edges,
        input.change,
      ),
      sharedContext: input.sharedContext,
      cwd: input.repo,
      schema: RoughEdgeChecks,
      model: input.models.verifier.model,
      effort: input.models.verifier.effort,
      timeoutMs: VERIFIER_TIMEOUT_MS,
    });
    if (result.output === null) {
      const failure = `${result.status}: ${result.error ?? "no output"}`;
      ctx.warn(`Rough edge check failed (${failure}); marked unclear.`);
      return applyChecks(edges, null, failure);
    }
    return applyChecks(edges, result.output, null);
  },
);
