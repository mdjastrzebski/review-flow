import { formatLocation } from "./format.ts";
import { codeFence } from "../runtime/prompts.ts";
import type {
  CheckedRoughEdge,
  NormalizedRoughEdge,
  Priority,
  RoughEdgeCheck,
  RoughEdgeChecks,
} from "./schemas.ts";

/**
 * Rough edges the checker did not rule out, highest final priority first; ties and runs without
 * priority keep reviewer order.
 */
export function keptRoughEdges(edges: readonly CheckedRoughEdge[]): CheckedRoughEdge[] {
  return edges
    .filter((edge) => edge.check.status !== "inaccurate")
    .sort((a, b) => priorityRank(a) - priorityRank(b));
}

function priorityRank(edge: CheckedRoughEdge): number {
  const priority = finalPriority(edge);
  return priority === null ? PRIORITY_ORDER.length : PRIORITY_ORDER.indexOf(priority);
}

/**
 * The final (checker's) priority. Runs saved before priority existed have none; they read as
 * null, since `rough-edges.json` is read back without validation.
 */
export function finalPriority(edge: CheckedRoughEdge): Priority | null {
  return (edge.check as Partial<RoughEdgeCheck>).priority ?? null;
}

const PRIORITY_ORDER: readonly Priority[] = ["high", "medium", "low"];

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
            priority: edge.priority,
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

/**
 * Each rough edge as the reviewer wrote it, for a prompt; shared by the checker and eval judge.
 * The suggestion is included: judging whether the observation holds can't be done without it.
 * Fenced, since it is agent text.
 */
export function describeRoughEdges(edges: readonly NormalizedRoughEdge[]): string {
  return edges
    .map((edge) =>
      [
        `### ${edge.id}: ${edge.title}`,
        `Location: \`${formatLocation(edge)}\` · lens: ${edge.lens} · reviewer priority: ${edge.priority}`,
        `Observation:\n\n${codeFence(edge.observation)}`,
        `Suggestion:\n\n${codeFence(edge.suggestion)}`,
      ].join("\n\n"),
    )
    .join("\n\n");
}

export const ROUGH_EDGE_CHECKER_TASK_ID = "verifier-rough-edges";
