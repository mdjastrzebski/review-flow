import { describe, expect, it } from "vitest";
import type { TimedTotals } from "./calls.ts";
import { compareSteps, matchFindings } from "./compare.ts";
import type { RunRecord } from "./pipeline.ts";
import type { NormalizedFinding } from "./schemas.ts";

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

describe("matchFindings", () => {
  it("pairs same-file findings within the tolerance, closest first, one to one", () => {
    const a = [finding("A1", "x.ts", 10, 12), finding("A2", "x.ts", 40), finding("A3", "y.ts", 5)];
    const b = [
      finding("B1", "x.ts", 14), // 2 lines from A1
      finding("B2", "x.ts", 11), // overlaps A1: wins over B1
      finding("B3", "x.ts", 50), // too far from A2
      finding("B4", "z.ts", 5), // other file
    ];
    const match = matchFindings(a, b);
    expect(match.both.map(([fa, fb]) => [fa.id, fb.id])).toEqual([["A1", "B2"]]);
    expect(match.onlyA.map((f) => f.id)).toEqual(["A2", "A3"]);
    expect(match.onlyB.map((f) => f.id)).toEqual(["B1", "B3", "B4"]);
  });

  it("lets a second finding take the next closest match", () => {
    const a = [finding("A1", "x.ts", 10), finding("A2", "x.ts", 12)];
    const b = [finding("B1", "x.ts", 10), finding("B2", "x.ts", 13)];
    expect(matchFindings(a, b).both.map(([fa, fb]) => [fa.id, fb.id])).toEqual([
      ["A1", "B1"],
      ["A2", "B2"],
    ]);
  });
});

function totals(costUsd: number | null, durationMs: number): TimedTotals {
  return {
    calls: 1,
    costUsd,
    unknownCostCalls: 0,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    durationMs,
  };
}

function run(steps: RunRecord["steps"]): RunRecord {
  return {
    harness: "claude",
    models: {
      summarizer: { model: "m", effort: null },
      reviewer: { model: "m", effort: null },
      verifier: { model: "m", effort: null },
    },
    base: { ref: "main", sha: "a" },
    head: { sha: "b" },
    startedAt: "",
    finishedAt: "",
    status: "ok",
    error: null,
    steps,
    totals: totals(1, 100),
  };
}

describe("compareSteps", () => {
  it("lines up steps from both runs, then the totals", () => {
    const a = run({ collect: totals(null, 1), review: totals(1, 50) });
    const b = run({ collect: totals(null, 1), review: totals(2, 60), verify: totals(1, 30) });
    const missing = (t: TimedTotals | null) => (t === null ? "missing" : t.costUsd);
    expect(compareSteps(a, b).map((s) => [s.step, missing(s.a), missing(s.b)])).toEqual([
      ["collect", null, null],
      ["review", 1, 2],
      ["verify", "missing", 1],
      ["total", 1, 1],
    ]);
  });
});
