import { describe, expect, it } from "vitest";
import { rollUp, sumCalls, type CallRecord } from "./calls.ts";

function call(overrides: Partial<CallRecord>): CallRecord {
  return {
    taskId: "reviewer",
    role: "reviewer",
    step: "review",
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

describe("rollUp", () => {
  it("totals each timed step from its calls, in step order", () => {
    const calls = [
      call({}),
      call({ taskId: "verifier-F-001", role: "verifier", step: "verify", costUsd: 1 }),
      call({ taskId: "verifier-F-002", role: "verifier", step: "verify", costUsd: 2 }),
    ];
    const durations = new Map([
      ["collect", 5],
      ["review", 100],
      ["verify", 150],
    ] as const);
    const { steps, totals } = rollUp(calls, durations, 300);

    expect(Object.keys(steps)).toEqual(["collect", "review", "verify"]);
    expect(steps.collect).toMatchObject({ calls: 0, costUsd: null, durationMs: 5 });
    expect(steps.review).toMatchObject({ calls: 1, costUsd: 0.5, durationMs: 100 });
    expect(steps.verify).toMatchObject({ calls: 2, costUsd: 3, durationMs: 150 });
    expect(totals).toMatchObject({ calls: 3, costUsd: 3.5, durationMs: 300 });
  });
});
