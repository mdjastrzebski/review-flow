import { z } from "zod";
import type { RunAgent } from "./agent.ts";
import type { ModelChoice } from "./models.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { describeRoughEdges } from "./rough-edges.ts";
import type { CheckedRoughEdge, NormalizedRoughEdge } from "./schemas.ts";
import { buildChangeContext, type ChangeRange } from "./verify.ts";

const EDGE_JUDGE_TIMEOUT_MS = 10 * 60_000;

/** The rubric, in the order the judge answers it; a rough edge is postable when all are yes. */
export const RUBRIC = ["accurate", "notLocal", "concrete", "worthPosting"] as const;
export type RubricQuestion = (typeof RUBRIC)[number];

export const EdgeJudgeOutput = z.strictObject({
  edges: z.array(
    z.strictObject({
      id: z.string(),
      reason: z.string(),
      accurate: z.boolean(),
      notLocal: z.boolean(),
      concrete: z.boolean(),
      worthPosting: z.boolean(),
    }),
  ),
});
export type EdgeJudgeOutput = z.infer<typeof EdgeJudgeOutput>;
export type EdgeGrade = Omit<EdgeJudgeOutput["edges"][number], "id">;

export const isPostable = (grade: EdgeGrade): boolean => RUBRIC.every((q) => grade[q]);

export type EdgeJudgeResult =
  | {
      status: "ok";
      /** Rough edge id to its grade; an edge the judge skipped or answered twice has none. */
      grades: Map<string, EdgeGrade>;
      costUsd: number | null;
      durationMs: number;
    }
  | { status: "failed"; error: string; costUsd: number | null; durationMs: number };

/** Unknown ids are dropped, and an id answered twice is left ungraded. */
export function gradesOf(
  output: EdgeJudgeOutput,
  edges: readonly NormalizedRoughEdge[],
): Map<string, EdgeGrade> {
  const known = new Set(edges.map((e) => e.id));
  const answers = new Map<string, EdgeGrade[]>();
  for (const { id, ...grade } of output.edges) {
    if (known.has(id)) answers.set(id, [...(answers.get(id) ?? []), grade]);
  }
  return new Map(
    [...answers].flatMap(([id, grades]) => (grades.length === 1 ? [[id, grades[0]!]] : [])),
  );
}

/**
 * Grades a case's rough edges with the rubric, from the code in `cwd` (the case's checkout) and the
 * diff. The judge sees what the reviewer wrote but not the checker's verdicts, so the two can be
 * compared. Inaccurate ones are graded too, to see what the checker dropped.
 */
export async function judgeRoughEdges(options: {
  caseId: string;
  edges: readonly CheckedRoughEdge[];
  change: ChangeRange;
  diff: string;
  cwd: string;
  model: ModelChoice;
  runAgent: RunAgent;
  signal?: AbortSignal;
}): Promise<EdgeJudgeResult> {
  const { edges, change } = options;
  if (edges.length === 0) return { status: "ok", grades: new Map(), costUsd: 0, durationMs: 0 };
  const [template, changeTemplate] = await Promise.all([
    loadPrompt("rough-edge-judge"),
    loadPrompt("change"),
  ]);
  const result = await options.runAgent({
    taskId: `judge-rough-edges-${options.caseId}`,
    role: "judge",
    prompt: renderPrompt(template, { ...change, items: describeRoughEdges(edges) }),
    sharedContext: buildChangeContext(changeTemplate, change, options.diff),
    cwd: options.cwd,
    schema: EdgeJudgeOutput,
    model: options.model.model,
    effort: options.model.effort,
    timeoutMs: EDGE_JUDGE_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: () => {},
  });
  if (result.status !== "ok" || result.output === null) {
    return {
      status: "failed",
      error: result.error ?? result.status,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
  }
  return {
    status: "ok",
    grades: gradesOf(result.output, edges),
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}
