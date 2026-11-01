import { describe, expect, it } from "vitest";
import type { EvalBug } from "./eval-dataset.ts";
import { hitsLocation, scoreBugs, summarizeCases, type CaseResult } from "./eval-score.ts";
import type { NormalizedFinding, Verdict } from "./schemas.ts";

function finding(
  id: string,
  file: string,
  lineStart: number,
  lineEnd = lineStart,
): NormalizedFinding {
  return {
    id,
    localId: id,
    title: id,
    file,
    lineStart,
    lineEnd,
    category: "correctness",
    severity: "medium",
    claim: "c",
    rationale: "r",
    suggestedFix: null,
  };
}

function verdict(value: Verdict["verdict"]): Verdict {
  return {
    verdict: value,
    severity: "medium",
    confidence: "high",
    fixCost: "small",
    evidence: [],
    summary: "s",
    fix: { assessment: "not_applicable", detail: "d", betterFix: null },
  };
}

const location = { file: "src/a.py", start: 20, end: 22 };

describe("hitsLocation", () => {
  it("needs the same file and lines overlapping or at most 3 apart", () => {
    expect(hitsLocation(finding("F", "src/a.py", 21), location)).toBe(true);
    expect(hitsLocation(finding("F", "src/a.py", 10, 30), location)).toBe(true);
    expect(hitsLocation(finding("F", "src/a.py", 25), location)).toBe(true);
    expect(hitsLocation(finding("F", "src/a.py", 14, 17), location)).toBe(true);
    expect(hitsLocation(finding("F", "src/a.py", 26), location)).toBe(false);
    expect(hitsLocation(finding("F", "src/b.py", 21), location)).toBe(false);
  });
});

describe("scoreBugs", () => {
  const bugs: EvalBug[] = [
    { description: "d", fix: "f", locations: [{ file: "x.py", start: 1, end: 1 }, location] },
  ];

  it("counts a bug found when a finding that wasn't refuted hits any location", () => {
    const findings = [finding("F-001", "src/a.py", 22), finding("F-002", "src/a.py", 90)];
    expect(scoreBugs(bugs, findings, { "F-001": verdict("inconclusive") })).toEqual([
      { description: "d", found: true, foundByReviewer: true, findingIds: ["F-001"] },
    ]);
  });

  it("counts a refuted hit for the reviewer only", () => {
    const findings = [finding("F-001", "src/a.py", 22)];
    expect(scoreBugs(bugs, findings, { "F-001": verdict("refuted") })).toEqual([
      { description: "d", found: false, foundByReviewer: true, findingIds: ["F-001"] },
    ]);
  });
});

const bug = (found: boolean, foundByReviewer: boolean) => [
  { description: "d", found, foundByReviewer, findingIds: [] },
];

describe("summarizeCases", () => {
  const base = { smoke: false, error: null, unknownCostCalls: 0, durationMs: 1000 };
  const cases: CaseResult[] = [
    {
      ...base,
      id: "a",
      kind: "bug",
      status: "ok",
      findings: 2,
      reported: 1,
      bugs: bug(true, true),
      costUsd: 1,
    },
    {
      ...base,
      id: "b",
      kind: "bug",
      status: "ok",
      findings: 1,
      reported: 0,
      bugs: bug(false, true),
      costUsd: 0.5,
    },
    {
      ...base,
      id: "c",
      kind: "bug",
      status: "ok",
      findings: 0,
      reported: 0,
      bugs: bug(false, false),
      costUsd: null,
      unknownCostCalls: 1,
    },
    {
      ...base,
      id: "d",
      kind: "clean",
      status: "ok",
      findings: 3,
      reported: 2,
      bugs: [],
      costUsd: 0.5,
    },
    {
      ...base,
      id: "e",
      kind: "clean",
      status: "failed",
      error: "x",
      findings: null,
      reported: null,
      bugs: null,
      costUsd: 0.25,
    },
  ];

  it("scores finished cases and sums cost and time over all", () => {
    expect(summarizeCases(cases)).toEqual({
      cases: 5,
      failed: 1,
      bugs: 3,
      found: 1,
      foundByReviewer: 2,
      recall: 1 / 3,
      reviewerRecall: 2 / 3,
      cleanCases: 1,
      cleanFindings: 2,
      findingsPerCleanCase: 2,
      costUsd: 2.25,
      unknownCostCalls: 1,
      durationMs: 5000,
    });
  });

  it("has no ratios without finished cases", () => {
    expect(summarizeCases([])).toMatchObject({
      recall: null,
      findingsPerCleanCase: null,
      costUsd: null,
    });
  });
});
