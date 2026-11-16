import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowNode, TimedTotals } from "../runtime/records.ts";
import { compareSteps, matchFindings, readRunRecord } from "./compare.ts";
import type { RunRecord } from "./flows/review.ts";
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

function node(name: string, t: TimedTotals, children: FlowNode[] = []): FlowNode {
  const { durationMs, ...callTotals } = t;
  return {
    name,
    kind: "flow",
    status: "ok",
    error: null,
    startedAt: "",
    durationMs,
    totals: callTotals,
    children,
  };
}

function run(steps: Record<string, TimedTotals>): RunRecord {
  return {
    format: 2,
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
    flow: node(
      "review",
      totals(1, 100),
      Object.entries(steps).map(([name, t]) => node(name, t)),
    ),
    totals: totals(1, 100),
  };
}

describe("compareSteps", () => {
  it("lines up steps from both runs, then the totals", () => {
    const a = run({ collect: totals(null, 1), find: totals(1, 50) });
    const b = run({ collect: totals(null, 1), find: totals(2, 60), report: totals(1, 30) });
    const missing = (t: TimedTotals | null) => (t === null ? "missing" : t.costUsd);
    expect(compareSteps(a, b).map((s) => [s.step, missing(s.a), missing(s.b)])).toEqual([
      ["collect", null, null],
      ["find", 1, 2],
      ["report", "missing", 1],
      ["total", 1, 1],
    ]);
  });

  it("shows only the totals while a run has no tree yet", () => {
    const running = { ...run({}), flow: null };
    expect(compareSteps(running, running).map((s) => s.step)).toEqual(["total"]);
  });
});

describe("readRunRecord", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "review-flow-compare-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a run from before the flow tree, with a clear error", async () => {
    await writeFile(path.join(root, "run.json"), JSON.stringify({ steps: {}, totals: {} }));
    await expect(readRunRecord(root)).rejects.toThrow(
      `Run ${path.basename(root)} uses the old record format; per-step comparison needs runs from this version.`,
    );
  });

  it("reads a run with the flow tree", async () => {
    await writeFile(path.join(root, "run.json"), JSON.stringify(run({})));
    expect(await readRunRecord<RunRecord>(root)).toMatchObject({ format: 2, status: "ok" });
  });
});
