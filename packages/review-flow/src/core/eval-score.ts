import { MATCH_TOLERANCE_LINES } from "./compare.ts";
import type { BugLocation, EvalBug, EvalCase } from "./eval-dataset.ts";
import type { NormalizedFinding, Verdict } from "./schemas.ts";

export interface BugResult {
  description: string;
  /** A finding that wasn't refuted hits the bug. */
  found: boolean;
  /** Any finding hits the bug, refuted or not. */
  foundByReviewer: boolean;
  /** Findings that hit the bug, refuted ones included. */
  findingIds: string[];
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
  const costs = cases.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]));
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
  };
}
