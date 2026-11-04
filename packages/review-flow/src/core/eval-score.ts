import { MATCH_TOLERANCE_LINES } from "./compare.ts";
import type { BugLocation, EvalBug, EvalCase } from "./eval-dataset.ts";
import {
  isPostable,
  RUBRIC,
  type EdgeJudgeResult,
  type RubricQuestion,
} from "./eval-edge-judge.ts";
import type { CheckedRoughEdge, NormalizedFinding, Verdict } from "./schemas.ts";

export interface BugResult {
  description: string;
  /** A finding that wasn't refuted hits the bug. */
  found: boolean;
  /** Any finding hits the bug, refuted or not. */
  foundByReviewer: boolean;
  /** Findings that hit the bug, refuted ones included. */
  findingIds: string[];
  /** Set when the judge decided the match; `found` and `foundByReviewer` are then its verdicts. */
  judged?: true;
  /** What matching by location alone gave, kept for comparison; only with `judged`. */
  byLocation?: { found: boolean; foundByReviewer: boolean };
}

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

/** One line of cases.json. */
export interface CaseResult {
  id: string;
  kind: EvalCase["kind"];
  preset: EvalCase["preset"];
  status: "ok" | "failed";
  error: string | null;
  /** All findings; null when the case failed before the reviewer returned. */
  findings: number | null;
  /** Findings not refuted; null when the case failed before verification finished. */
  reported: number | null;
  /** Bug cases that finished; empty for clean cases, null when the case failed. */
  bugs: BugResult[] | null;
  costUsd: number | null;
  unknownCostCalls: number;
  durationMs: number;
  /** The judge call: null or absent when the case wasn't judged. Its cost isn't in `costUsd`. */
  judge?: JudgeCall | null;
  /** Absent when the eval ran without rough edges; null when the case failed before review. */
  roughEdges?: RoughEdgeResult | null;
}

export interface JudgeCall {
  status: "ok" | "failed";
  error: string | null;
  costUsd: number | null;
  durationMs: number;
}

export interface EvalScores {
  cases: number;
  failed: number;
  /** Known bugs in the bug cases that finished. */
  bugs: number;
  found: number;
  foundByReviewer: number;
  /** null when no bug case finished. */
  recall: number | null;
  reviewerRecall: number | null;
  /** Clean cases that finished, and the findings not refuted on them. */
  cleanCases: number;
  cleanFindings: number;
  /** null when no clean case finished. */
  findingsPerCleanCase: number | null;
  /** Sum over all cases, failed ones included. null when no call has a cost. */
  costUsd: number | null;
  /** When above 0, `costUsd` is a lower bound. */
  unknownCostCalls: number;
  /** Sum of case run times. */
  durationMs: number;
  /** Recall by location alone, for comparison; only when some bug was judged. */
  locationRecall?: number | null;
  /** Sum of the judge calls' cost; only when some case was judged. */
  judgeCostUsd?: number | null;
  /** Only when the eval ran with rough edges. */
  roughEdges?: RoughEdgeScores;
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

/** Same file, and the line ranges overlap or are at most MATCH_TOLERANCE_LINES apart. */
export function hitsLocation(finding: NormalizedFinding, location: BugLocation): boolean {
  const gap = Math.max(0, finding.lineStart - location.end, location.start - finding.lineEnd);
  return finding.file === location.file && gap <= MATCH_TOLERANCE_LINES;
}

export function scoreBugs(
  bugs: readonly EvalBug[],
  findings: readonly NormalizedFinding[],
  verdicts: Readonly<Record<string, Verdict>>,
): BugResult[] {
  return bugs.map((bug) => {
    const hits = findings.filter((f) => bug.locations.some((l) => hitsLocation(f, l)));
    return {
      description: bug.description,
      found: hits.some((f) => verdicts[f.id]?.verdict !== "refuted"),
      foundByReviewer: hits.length > 0,
      findingIds: hits.map((f) => f.id),
    };
  });
}

/**
 * Scores bugs from the judge's matches instead of line numbers: a bug is found when the judge
 * matched a finding that wasn't refuted to it, wherever the finding points.
 */
export function judgeBugs(
  bugs: readonly EvalBug[],
  findings: readonly NormalizedFinding[],
  verdicts: Readonly<Record<string, Verdict>>,
  matches: ReadonlyMap<number, ReadonlySet<string>>,
): BugResult[] {
  const byLocation = scoreBugs(bugs, findings, verdicts);
  return bugs.map((bug, index) => {
    const ids = findings.map((f) => f.id).filter((id) => matches.get(index)?.has(id));
    const location = byLocation[index];
    return {
      description: bug.description,
      found: ids.some((id) => verdicts[id]?.verdict !== "refuted"),
      foundByReviewer: ids.length > 0,
      findingIds: ids,
      judged: true,
      byLocation: {
        found: location?.found ?? false,
        foundByReviewer: location?.foundByReviewer ?? false,
      },
    };
  });
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

function summarizeRoughEdges(ok: readonly CaseResult[]): RoughEdgeScores | undefined {
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

export function countReported(verdicts: Readonly<Record<string, Verdict>>): number {
  return Object.values(verdicts).filter((v) => v.verdict !== "refuted").length;
}

export function summarizeCases(cases: readonly CaseResult[]): EvalScores {
  const ok = cases.filter((c) => c.status === "ok");
  const bugs = ok.flatMap((c) => c.bugs ?? []);
  const clean = ok.filter((c) => c.kind === "clean");
  const found = bugs.filter((b) => b.found).length;
  const foundByReviewer = bugs.filter((b) => b.foundByReviewer).length;
  const cleanFindings = clean.reduce((sum, c) => sum + (c.reported ?? 0), 0);
  const judged = bugs.filter((b) => b.judged === true);
  const judgeCosts = ok.flatMap((c) => (c.judge?.costUsd == null ? [] : [c.judge.costUsd]));
  const costs = cases.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]));
  const roughEdges = summarizeRoughEdges(ok);
  return {
    cases: cases.length,
    failed: cases.length - ok.length,
    bugs: bugs.length,
    found,
    foundByReviewer,
    recall: bugs.length === 0 ? null : found / bugs.length,
    reviewerRecall: bugs.length === 0 ? null : foundByReviewer / bugs.length,
    cleanCases: clean.length,
    cleanFindings,
    findingsPerCleanCase: clean.length === 0 ? null : cleanFindings / clean.length,
    costUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    unknownCostCalls: cases.reduce((sum, c) => sum + c.unknownCostCalls, 0),
    durationMs: cases.reduce((sum, c) => sum + c.durationMs, 0),
    ...(judged.length === 0
      ? {}
      : {
          locationRecall:
            bugs.length === 0
              ? null
              : bugs.filter((b) => (b.byLocation?.found ?? b.found) === true).length / bugs.length,
          judgeCostUsd: judgeCosts.length === 0 ? null : judgeCosts.reduce((a, b) => a + b, 0),
        }),
    ...(roughEdges === undefined ? {} : { roughEdges }),
  };
}
