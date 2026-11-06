import { describe, expect, it } from "vitest";
import { Finding, FindingsOutput, ReviewOutput, RoughEdgeChecks, Verdict } from "./schemas.ts";

const finding = {
  localId: "1",
  title: "Off-by-one in pagination",
  file: "src/page.ts",
  lineStart: 10,
  lineEnd: 12,
  category: "correctness",
  severity: "high",
  claim: "The last page is never returned.",
  rationale: "Loop uses < instead of <=.",
  suggestedFix: "Use <= in the loop condition.",
};

const verdict = {
  verdict: "confirmed",
  severity: "medium",
  confidence: "high",
  fixCost: "trivial",
  evidence: [{ kind: "code_ref", file: "src/page.ts", line: 11, detail: "i < pages" }],
  summary: "Last page is skipped.",
  fix: { assessment: "sound", detail: "Covers the only call site.", betterFix: null },
};

describe("Finding", () => {
  it("accepts a valid finding", () => {
    expect(Finding.parse(finding)).toEqual(finding);
  });

  it("accepts null suggestedFix", () => {
    expect(Finding.safeParse({ ...finding, suggestedFix: null }).success).toBe(true);
  });

  it("rejects a missing suggestedFix (null, not optional)", () => {
    const { suggestedFix: _, ...rest } = finding;
    expect(Finding.safeParse(rest).success).toBe(false);
  });

  it("rejects unknown category and severity", () => {
    expect(Finding.safeParse({ ...finding, category: "style" }).success).toBe(false);
    expect(Finding.safeParse({ ...finding, severity: "blocker" }).success).toBe(false);
  });

  it("rejects non-positive or fractional line numbers", () => {
    expect(Finding.safeParse({ ...finding, lineStart: 0 }).success).toBe(false);
    expect(Finding.safeParse({ ...finding, lineEnd: 1.5 }).success).toBe(false);
  });

  it("rejects extra keys", () => {
    expect(Finding.safeParse({ ...finding, patch: "diff" }).success).toBe(false);
  });
});

describe("ReviewOutput", () => {
  it("accepts empty findings and rough edges", () => {
    expect(ReviewOutput.safeParse({ findings: [], roughEdges: [] }).success).toBe(true);
  });

  it("requires roughEdges, since absent values are not allowed", () => {
    expect(ReviewOutput.safeParse({ findings: [] }).success).toBe(false);
  });

  it("rejects a bare array", () => {
    expect(ReviewOutput.safeParse([finding]).success).toBe(false);
  });
});

describe("rough edge priority", () => {
  const edge = {
    localId: "1",
    title: "t",
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 2,
    lens: "design",
    priority: "high",
    observation: "o",
    suggestion: "s",
  };
  const parse = (e: object) => ReviewOutput.safeParse({ findings: [], roughEdges: [e] }).success;

  it("is required on a reviewer's rough edge and limited to high, medium, low", () => {
    expect(parse(edge)).toBe(true);
    const { priority: _drop, ...without } = edge;
    expect(parse(without)).toBe(false);
    expect(parse({ ...edge, priority: "critical" })).toBe(false);
  });

  it("is required on each check", () => {
    const check = { localId: "R-001", status: "accurate", note: "n" };
    expect(RoughEdgeChecks.safeParse({ checks: [check] }).success).toBe(false);
    expect(RoughEdgeChecks.safeParse({ checks: [{ ...check, priority: "low" }] }).success).toBe(
      true,
    );
  });
});

describe("FindingsOutput", () => {
  it("rejects rough edges, which were not asked for", () => {
    expect(FindingsOutput.safeParse({ findings: [] }).success).toBe(true);
    expect(FindingsOutput.safeParse({ findings: [], roughEdges: [] }).success).toBe(false);
  });
});

describe("Verdict", () => {
  it("accepts a valid verdict", () => {
    expect(Verdict.parse(verdict)).toEqual(verdict);
  });

  it("accepts reasoning evidence with null file and line", () => {
    const evidence = [{ kind: "reasoning", file: null, line: null, detail: "..." }];
    expect(Verdict.safeParse({ ...verdict, evidence }).success).toBe(true);
  });

  it("rejects unknown verdict and fix assessment", () => {
    expect(Verdict.safeParse({ ...verdict, verdict: "maybe" }).success).toBe(false);
    expect(
      Verdict.safeParse({ ...verdict, fix: { ...verdict.fix, assessment: "great" } }).success,
    ).toBe(false);
  });

  it("rejects a fix without betterFix", () => {
    const { betterFix: _, ...fix } = verdict.fix;
    expect(Verdict.safeParse({ ...verdict, fix }).success).toBe(false);
  });
});
