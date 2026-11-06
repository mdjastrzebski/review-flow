import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunAgent } from "./agent.ts";
import type { EvalCase } from "./eval-dataset.ts";
import {
  countRoughEdges,
  tallyEdgeJudge,
  type EdgeGrade,
  type EdgeJudgeResult,
  type RoughEdgeResult,
} from "./eval-rough-edge-score.ts";
import { writeJson } from "./json.ts";
import type { Harness, ModelChoice } from "./models.ts";
import type { ReviewRunResult, RunRecord } from "./pipeline.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { describeRoughEdges } from "./rough-edges.ts";
import { runDirPaths } from "./run-dir.ts";
import type { CheckedRoughEdge, NormalizedRoughEdge } from "./schemas.ts";
import { buildChangeContext, changeRangeOf, type ChangeRange } from "./verify.ts";

const EDGE_JUDGE_TIMEOUT_MS = 10 * 60_000;

/** The judge's answers, one per rough edge, in RUBRIC order. */
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

/** The rough-edge judge: another model than the reviewer's, possibly on another harness. */
export interface EdgeJudge {
  harness: Harness;
  model: ModelChoice;
  runAgent: RunAgent;
}

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

/**
 * Scores a case's rough edges: the checker's verdicts and the check step's cost, then, with a
 * judge, the rubric grades, saved beside the checker's verdicts in `rough-edge-judge.json`. Null
 * when the review failed.
 */
export async function scoreRoughEdges(options: {
  evalCase: EvalCase;
  review: ReviewRunResult | null;
  run: RunRecord | null;
  caseRoot: string;
  judge?: EdgeJudge | undefined;
  warn?: ((message: string) => void) | undefined;
}): Promise<RoughEdgeResult | null> {
  const { evalCase, review, caseRoot, judge } = options;
  if (review === null) return null;
  const check = options.run?.steps.check;
  // No check step: the reviewer returned none, so nothing was spent.
  const checkCost = check === undefined ? 0 : check.unknownCostCalls > 0 ? null : check.costUsd;
  const roughEdges = countRoughEdges(review.roughEdges, checkCost);
  if (judge === undefined) return roughEdges;

  const edges = review.roughEdges;
  let result: EdgeJudgeResult;
  try {
    result = await judgeRoughEdges({
      caseId: evalCase.id,
      edges,
      change: changeRangeOf(evalCase.base, { uncommitted: false }),
      diff: await readFile(runDirPaths(caseRoot).diffPath, "utf8"),
      cwd: review.checkout,
      model: judge.model,
      runAgent: judge.runAgent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { status: "failed", error: message, costUsd: null, durationMs: 0 };
  }
  if (result.status === "ok") {
    const { grades } = result;
    await writeJson(
      path.join(caseRoot, "rough-edge-judge.json"),
      edges.map((e) => ({
        id: e.id,
        title: e.title,
        check: e.check.status,
        grade: grades.get(e.id) ?? null,
      })),
    );
  }
  roughEdges.judge = tallyEdgeJudge(edges, result);
  if (roughEdges.judge.status === "failed") {
    options.warn?.(
      `${evalCase.id}: the rough-edge judge failed (${roughEdges.judge.error ?? "no result"}).`,
    );
  }
  return roughEdges;
}
