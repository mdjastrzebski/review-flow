import { formatLocation } from "./format.ts";
import { codeFence, renderPrompt } from "./prompts.ts";
import type {
  CheckedRoughEdge,
  NormalizedRoughEdge,
  RoughEdgeCheck,
  RoughEdgeChecks,
} from "./schemas.ts";
import type { ChangeRange } from "./verify.ts";

export const ROUGH_EDGE_CHECKER_TASK_ID = "verifier-rough-edges";

/**
 * The checker sees what the reviewer wrote, suggestion included: it judges whether the
 * observation holds, which can't be done without it. Fenced, since it is agent text.
 */
export function buildRoughEdgeCheckerPrompt(
  template: string,
  edges: readonly NormalizedRoughEdge[],
  change: ChangeRange,
): string {
  const items = edges
    .map((edge) =>
      [
        `### ${edge.id}: ${edge.title}`,
        `Location: \`${formatLocation(edge)}\` · lens: ${edge.lens}`,
        `Observation:\n\n${codeFence(edge.observation)}`,
        `Suggestion:\n\n${codeFence(edge.suggestion)}`,
      ].join("\n\n"),
    )
    .join("\n\n");
  return renderPrompt(template, { ...change, items });
}

/**
 * Pairs each rough edge with its check. The checker answers by id; an edge it skipped or answered
 * twice is `unclear`, since nobody settled it.
 */
export function applyChecks(
  edges: readonly NormalizedRoughEdge[],
  output: RoughEdgeChecks | null,
  failure: string | null,
): CheckedRoughEdge[] {
  const answers = new Map<string, RoughEdgeCheck[]>();
  for (const { localId, ...check } of output?.checks ?? []) {
    answers.set(localId, [...(answers.get(localId) ?? []), check]);
  }
  return edges.map((edge): CheckedRoughEdge => {
    const answered = answers.get(edge.id) ?? answers.get(edge.localId) ?? [];
    const check: RoughEdgeCheck =
      answered.length === 1
        ? answered[0]!
        : {
            status: "unclear",
            note:
              failure !== null
                ? `Check failed (${failure}).`
                : answered.length === 0
                  ? "The checker gave no answer."
                  : "The checker answered more than once.",
          };
    return { ...edge, check };
  });
}

/** Rough edges the checker did not rule out, in reviewer order. */
export function keptRoughEdges(edges: readonly CheckedRoughEdge[]): CheckedRoughEdge[] {
  return edges.filter((edge) => edge.check.status !== "inaccurate");
}
