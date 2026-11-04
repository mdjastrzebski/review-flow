import type { EvalCase } from "./eval-dataset.ts";
import type { CheckedRoughEdge } from "./schemas.ts";

/** The rubric, in the order the judge answers it; a rough edge is postable when all are yes. */
export const RUBRIC = ["accurate", "notLocal", "concrete", "worthPosting"] as const;
export type RubricQuestion = (typeof RUBRIC)[number];

/** The rubric judge's answers on one rough edge. */
export type EdgeGrade = { reason: string } & Record<RubricQuestion, boolean>;

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

/** A case's rough edges by the checker's status, and what the check cost. */
export interface RoughEdgeResult {
  accurate: number;
  unclear: number;
  inaccurate: number;
  /** The `check` step; 0 when there was nothing to check, null when its cost is unknown. */
  checkCostUsd: number | null;
  /** The rubric judge; absent when not judged. */
  judge?: EdgeJudgeTally;
}

/** The rubric judge's call on a case, and what it decided. Its cost isn't in the case's `costUsd`. */
export interface EdgeJudgeTally {
  status: "ok" | "failed";
  error: string | null;
  costUsd: number | null;
  durationMs: number;
  /** Graded rough edges the checker kept (not inaccurate), and how many of them pass the rubric. */
  kept: number;
  keptPostable: number;
  /** Graded rough edges the checker marked inaccurate, and how many of them pass the rubric. */
  dropped: number;
  droppedPostable: number;
  /** Graded rough edges answered no, per question. */
  no: Record<RubricQuestion, number>;
}

export interface RoughEdgeScores {
  /** Cases that finished with rough edges on. */
  cases: number;
  accurate: number;
  unclear: number;
  inaccurate: number;
  /** Rough edges the checker kept (not inaccurate), per case; null when no case finished. */
  keptPerCase: number | null;
  /** Kept ones on clean cases, per clean case; null when no clean case finished. */
  keptPerCleanCase: number | null;
  /** Sum of the check steps; null when none has a cost. Included in `costUsd`. */
  checkCostUsd: number | null;
  /** Cases whose check cost is unknown; when above 0, `checkCostUsd` is a lower bound. */
  unknownCheckCost: number;
  /** Only when some case was judged. */
  judge?: RoughEdgeJudgeScores;
}

/** The rubric judge's scores, over the cases it judged; rates are null with nothing to divide. */
export interface RoughEdgeJudgeScores {
  cases: number;
  /** Cases whose judge call failed; not in the counts below. */
  failed: number;
  graded: number;
  /** Graded rough edges that pass all four questions. */
  postable: number;
  postableRate: number | null;
  /** Checker calibration: kept by the checker but rejected by the judge, of those kept. */
  kept: number;
  keptRejected: number;
  keptRejectedRate: number | null;
  /** Dropped by the checker (inaccurate) but postable to the judge, of those dropped. */
  dropped: number;
  droppedAccepted: number;
  droppedAcceptedRate: number | null;
  no: Record<RubricQuestion, number>;
  /** Sum of the judge calls' cost; null when none has a cost. Not in `costUsd`. */
  costUsd: number | null;
}

export function countRoughEdges(
  edges: readonly CheckedRoughEdge[],
  checkCostUsd: number | null,
): RoughEdgeResult {
  const count = (status: CheckedRoughEdge["check"]["status"]) =>
    edges.filter((e) => e.check.status === status).length;
  return {
    accurate: count("accurate"),
    unclear: count("unclear"),
    inaccurate: count("inaccurate"),
    checkCostUsd,
  };
}

const kept = (r: RoughEdgeResult) => r.accurate + r.unclear;

const noAnswers = (): Record<RubricQuestion, number> =>
  Object.fromEntries(RUBRIC.map((q) => [q, 0])) as Record<RubricQuestion, number>;

/** Counts the judge's grades against the checker's verdicts; a failed call counts nothing. */
export function tallyEdgeJudge(
  edges: readonly CheckedRoughEdge[],
  result: EdgeJudgeResult,
): EdgeJudgeTally {
  const tally: EdgeJudgeTally = {
    status: result.status,
    error: result.status === "failed" ? result.error : null,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    kept: 0,
    keptPostable: 0,
    dropped: 0,
    droppedPostable: 0,
    no: noAnswers(),
  };
  if (result.status === "failed") return tally;
  for (const edge of edges) {
    const grade = result.grades.get(edge.id);
    if (grade === undefined) continue;
    const postable = isPostable(grade) ? 1 : 0;
    if (edge.check.status === "inaccurate") {
      tally.dropped++;
      tally.droppedPostable += postable;
    } else {
      tally.kept++;
      tally.keptPostable += postable;
    }
    for (const q of RUBRIC) if (!grade[q]) tally.no[q]++;
  }
  return tally;
}

const rate = (n: number, d: number) => (d === 0 ? null : n / d);

function summarizeEdgeJudge(tallies: readonly EdgeJudgeTally[]): RoughEdgeJudgeScores | undefined {
  if (tallies.length === 0) return undefined;
  const ok = tallies.filter((t) => t.status === "ok");
  const sum = (of: (t: EdgeJudgeTally) => number) => ok.reduce((a, t) => a + of(t), 0);
  const keptGraded = sum((t) => t.kept);
  const dropped = sum((t) => t.dropped);
  const keptRejected = keptGraded - sum((t) => t.keptPostable);
  const droppedAccepted = sum((t) => t.droppedPostable);
  const postable = sum((t) => t.keptPostable) + droppedAccepted;
  const costs = tallies.flatMap((t) => (t.costUsd === null ? [] : [t.costUsd]));
  const no = noAnswers();
  for (const q of RUBRIC) no[q] = sum((t) => t.no[q]);
  return {
    cases: ok.length,
    failed: tallies.length - ok.length,
    graded: keptGraded + dropped,
    postable,
    postableRate: rate(postable, keptGraded + dropped),
    kept: keptGraded,
    keptRejected,
    keptRejectedRate: rate(keptRejected, keptGraded),
    dropped,
    droppedAccepted,
    droppedAcceptedRate: rate(droppedAccepted, dropped),
    no,
    costUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
  };
}

/** Rough-edge scores over the cases that finished; undefined when none had rough edges on. */
export function summarizeRoughEdges(
  ok: readonly { kind: EvalCase["kind"]; roughEdges?: RoughEdgeResult | null }[],
): RoughEdgeScores | undefined {
  const scored = ok.flatMap((c) =>
    c.roughEdges == null ? [] : [{ kind: c.kind, ...c.roughEdges }],
  );
  if (scored.length === 0) return undefined;
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  const clean = scored.filter((r) => r.kind === "clean");
  const costs = scored.flatMap((r) => (r.checkCostUsd === null ? [] : [r.checkCostUsd]));
  const judge = summarizeEdgeJudge(scored.flatMap((r) => (r.judge === undefined ? [] : [r.judge])));
  return {
    cases: scored.length,
    accurate: sum(scored.map((r) => r.accurate)),
    unclear: sum(scored.map((r) => r.unclear)),
    inaccurate: sum(scored.map((r) => r.inaccurate)),
    keptPerCase: sum(scored.map(kept)) / scored.length,
    keptPerCleanCase: clean.length === 0 ? null : sum(clean.map(kept)) / clean.length,
    checkCostUsd: costs.length === 0 ? null : sum(costs),
    unknownCheckCost: scored.length - costs.length,
    ...(judge === undefined ? {} : { judge }),
  };
}

/**
 * `N kept (A accurate, U unclear, I inaccurate)`, plus `, P postable` when judged; null when the
 * case has no rough-edge result.
 */
export function roughEdgeOutcome(result: { roughEdges?: RoughEdgeResult | null }): string | null {
  const r = result.roughEdges;
  if (r == null) return null;
  const text = `${r.accurate + r.unclear} kept (${r.accurate} accurate, ${r.unclear} unclear, ${r.inaccurate} inaccurate)`;
  if (r.judge?.status !== "ok") return text;
  return `${text}, ${r.judge.keptPostable + r.judge.droppedPostable} postable`;
}
