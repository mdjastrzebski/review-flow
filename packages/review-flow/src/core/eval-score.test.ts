import { describe, expect, it } from "vitest";
import type { EvalBug } from "./eval-dataset.ts";
import {
  hitsLocation,
  judgeBugs,
  scoreBugs,
  summarizeCases,
  type CaseResult,
} from "./eval-score.ts";
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

describe("judgeBugs", () => {
  const bugs: EvalBug[] = [{ description: "d", fix: "f", locations: [location] }];

  it("trusts the judge's matches over lines, and keeps the location result", () => {
    // F-001 is on the bug's lines but the judge says it is another defect; F-002 is far away.
    const findings = [finding("F-001", "src/a.py", 21), finding("F-002", "src/a.py", 90)];
    const verdicts = { "F-001": verdict("confirmed"), "F-002": verdict("confirmed") };
    expect(judgeBugs(bugs, findings, verdicts, new Map([[0, new Set(["F-002"])]]))).toEqual([
      {
        description: "d",
        found: true,
        foundByReviewer: true,
        findingIds: ["F-002"],
        judged: true,
        byLocation: { found: true, foundByReviewer: true },
      },
    ]);
  });

  it("finds nothing when the judge matches nothing, and counts a refuted match for the reviewer", () => {
    const findings = [finding("F-001", "src/a.py", 21)];
    const confirmed = { "F-001": verdict("confirmed") };
    expect(judgeBugs(bugs, findings, confirmed, new Map())[0]).toMatchObject({
      found: false,
      foundByReviewer: false,
      byLocation: { found: true },
    });
    const refuted = { "F-001": verdict("refuted") };
    expect(judgeBugs(bugs, findings, refuted, new Map([[0, new Set(["F-001"])]]))[0]).toMatchObject(
      { found: false, foundByReviewer: true },
    );
  });
});

const bug = (found: boolean, foundByReviewer: boolean) => [
  { description: "d", found, foundByReviewer, findingIds: [] },
];

describe("summarizeCases", () => {
  const base = { preset: "full" as const, error: null, unknownCostCalls: 0, durationMs: 1000 };
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

  it("adds recall by location and the judge's cost when bugs were judged", () => {
    const judged = (found: boolean, byLocation: boolean): CaseResult => ({
      ...base,
      id: "j",
      kind: "bug",
      status: "ok",
      findings: 1,
      reported: 1,
      bugs: [
        {
          description: "d",
          found,
          foundByReviewer: found,
          findingIds: [],
          judged: true,
          byLocation: { found: byLocation, foundByReviewer: byLocation },
        },
      ],
      costUsd: 1,
      judge: { status: "ok", error: null, costUsd: 0.05, durationMs: 10 },
    });
    expect(summarizeCases([judged(false, true), judged(true, true)])).toMatchObject({
      recall: 0.5,
      locationRecall: 1,
      judgeCostUsd: 0.1,
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

describe("summarizeCases with rough edges", () => {
  const base: CaseResult = {
    id: "x",
    kind: "bug",
    preset: "full",
    status: "ok",
    error: null,
    findings: 0,
    reported: 0,
    bugs: [],
    costUsd: 1,
    unknownCostCalls: 0,
    durationMs: 1,
  };

  it("sums verdicts, kept per case and per clean case, and check cost", () => {
    const scores = summarizeCases([
      { ...base, roughEdges: { accurate: 2, unclear: 1, inaccurate: 1, checkCostUsd: 0.1 } },
      {
        ...base,
        kind: "clean",
        roughEdges: { accurate: 0, unclear: 1, inaccurate: 0, checkCostUsd: null },
      },
      // A failed case isn't scored.
      { ...base, status: "failed", roughEdges: null },
    ]);
    expect(scores.roughEdges).toEqual({
      cases: 2,
      accurate: 2,
      unclear: 2,
      inaccurate: 1,
      keptPerCase: 2,
      keptPerCleanCase: 1,
      checkCostUsd: 0.1,
      unknownCheckCost: 1,
    });
  });

  it("has no rough-edge scores when no case ran with them", () => {
    expect(summarizeCases([base])).not.toHaveProperty("roughEdges");
  });
});
