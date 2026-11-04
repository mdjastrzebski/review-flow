import { MATCH_TOLERANCE_LINES } from "./compare.ts";
import type { BugLocation, EvalBug, EvalCase } from "./eval-dataset.ts";
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

function summarizeRoughEdges(ok: readonly CaseResult[]): RoughEdgeScores | undefined {
  const scored = ok.flatMap((c) =>
    c.roughEdges == null ? [] : [{ kind: c.kind, ...c.roughEdges }],
  );
  if (scored.length === 0) return undefined;
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  const clean = scored.filter((r) => r.kind === "clean");
  const costs = scored.flatMap((r) => (r.checkCostUsd === null ? [] : [r.checkCostUsd]));
  return {
    cases: scored.length,
    accurate: sum(scored.map((r) => r.accurate)),
    unclear: sum(scored.map((r) => r.unclear)),
    inaccurate: sum(scored.map((r) => r.inaccurate)),
    keptPerCase: sum(scored.map(kept)) / scored.length,
    keptPerCleanCase: clean.length === 0 ? null : sum(clean.map(kept)) / clean.length,
    checkCostUsd: costs.length === 0 ? null : sum(costs),
    unknownCheckCost: scored.length - costs.length,
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
