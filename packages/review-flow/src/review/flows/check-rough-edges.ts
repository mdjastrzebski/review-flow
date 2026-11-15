import { describeFailure } from "../../runtime/agent.ts";
import type { FlowContext } from "../../runtime/flow.ts";
import { renderPrompt } from "../prompts.ts";
import { ROUGH_EDGE_CHECKER_TASK_ID, applyChecks, describeRoughEdges } from "../rough-edges.ts";
import { RoughEdgeChecks, type CheckedRoughEdge, type NormalizedRoughEdge } from "../schemas.ts";
import { runRole, type ReviewScope } from "./scope.ts";

export interface CheckRoughEdgesInput {
  scope: ReviewScope;
  edges: readonly NormalizedRoughEdge[];
}

/**
 * One batched checker session for all rough edges, in the verifier role. It runs after the
 * finding verifiers so the shared diff is already cached. A failed or incomplete answer leaves
 * the edges `unclear`; anything thrown stops the run.
 */
export async function checkRoughEdges(
  input: CheckRoughEdgesInput,
  ctx: FlowContext,
): Promise<CheckedRoughEdge[]> {
  const { scope, edges } = input;
  const result = await runRole(ctx, scope, "verifier", {
    taskId: ROUGH_EDGE_CHECKER_TASK_ID,
    prompt: renderPrompt("rough-edge-checker", {
      ...scope.change,
      items: describeRoughEdges(edges),
    }),
    schema: RoughEdgeChecks,
  });
  if (result.status === "failure") {
    const failure = describeFailure(result);
    ctx.warn(`Rough edge check failed (${failure}); marked unclear.`);
    return applyChecks(edges, null, failure);
  }
  return applyChecks(edges, result.output, null);
}
