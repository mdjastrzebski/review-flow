import { describe, expect, it } from "vitest";
import { findNode, flattenTree, sumCalls, type CallRecord, type FlowNode } from "./records.ts";

function call(overrides: Partial<CallRecord>): CallRecord {
  return {
    taskId: "reviewer",
    role: "reviewer",
    path: "review/find/review",
    harness: "claude",
    model: "m",
    effort: "high",
    status: "ok",
    error: null,
    usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
    costUsd: 0.5,
    costSource: "reported",
    startedAt: "2026-11-01T00:00:00.000Z",
    durationMs: 100,
    outsideReads: [],
    ...overrides,
  };
}

describe("sumCalls", () => {
  it("returns zero tokens and a null cost for no calls", () => {
    expect(sumCalls([])).toEqual({
      calls: 0,
      costUsd: null,
      unknownCostCalls: 0,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
  });

  it("sums known costs and tokens, and counts calls without a cost", () => {
    const totals = sumCalls([
      call({}),
      call({ costUsd: 0.25 }),
      call({ costUsd: null, costSource: "unknown", usage: null }),
    ]);
    expect(totals).toEqual({
      calls: 3,
      costUsd: 0.75,
      unknownCostCalls: 1,
      usage: { input: 2, cacheRead: 4, cacheWrite: 6, output: 8 },
    });
  });
});

function node(name: string, costUsd: number | null, children: FlowNode[] = []): FlowNode {
  return {
    name,
    kind: "flow",
    status: "ok",
    error: null,
    startedAt: "2026-11-01T00:00:00.000Z",
    durationMs: 10,
    totals: {
      ...sumCalls(costUsd === null ? [] : [call({ costUsd })]),
    },
    children,
  };
}

describe("flattenTree", () => {
  it("lists totals per path below the root, in start order", () => {
    const tree = node("review", 3, [
      node("collect", null),
      node("find", 3, [node("review", 1), node("verify", 2, [node("verifier:F-001", 2)])]),
    ]);
    const flat = flattenTree(tree);
    expect([...flat.keys()]).toEqual(["collect", "find", "find/review", "find/verify"]);
    expect(flat.get("find/verify")).toMatchObject({ calls: 1, costUsd: 2, durationMs: 10 });
    expect(findNode(tree, "find/verify")?.name).toBe("verify");
    expect(findNode(tree, "find/check")).toBeUndefined();
  });

  it("sums the children of instance nodes across instances", () => {
    const tree = node("eval", 3, [
      { ...node("a", 1, [node("review", 1, [node("find", 1)])]), instance: true },
      { ...node("b", 2, [node("review", 2, [node("find", 2)])]), instance: true },
    ]);
    const flat = flattenTree(tree);
    expect([...flat.keys()]).toEqual(["review", "review/find"]);
    expect(flat.get("review/find")).toMatchObject({ calls: 2, costUsd: 3, durationMs: 20 });
  });

  it("treats a colon in the name as an instance in older records", () => {
    const tree = node("eval", 3, [
      node("case:a", 1, [node("review", 1)]),
      node("case:b", 2, [node("review", 2)]),
    ]);
    expect([...flattenTree(tree).keys()]).toEqual(["review"]);
  });

  it("is empty without a tree", () => {
    expect(flattenTree(null).size).toBe(0);
  });
});
