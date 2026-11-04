import { describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import { judgePair, summarizePairwise, type PairwiseCase } from "./eval-pairwise.ts";
import type { CheckedRoughEdge } from "./schemas.ts";

function edge(title: string): CheckedRoughEdge {
  return {
    id: "R-001",
    localId: "1",
    title,
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 9,
    lens: "design",
    observation: `observation ${title}`,
    suggestion: `suggestion ${title}`,
    check: { status: "accurate", note: "checker note" },
  };
}

function answering(preferred: "1" | "2" | "tie", seen: AgentTask<unknown>[] = []): RunAgent {
  return async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    seen.push(task as AgentTask<unknown>);
    return {
      status: "ok",
      output: task.schema.parse({ reason: "because", preferred }),
      rawText: "",
      raw: {},
      error: null,
      costUsd: 0.2,
      usage: null,
      durationMs: 5,
    };
  };
}

const options = {
  caseId: "c-1",
  a: [edge("from A")],
  b: [edge("from B")],
  change: { base: "abc", head: "`HEAD`" },
  diff: "+new line",
  cwd: "/checkout",
  model: { model: "judge-model", effort: null },
};

describe("judgePair", () => {
  it("shows A first or second by the coin, and maps the answer back", async () => {
    const seen: AgentTask<unknown>[] = [];
    const aFirst = await judgePair({
      ...options,
      runAgent: answering("1", seen),
      random: () => 0.1,
    });
    expect(aFirst).toMatchObject({ winner: "a", aFirst: true, reason: "because", costUsd: 0.2 });
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt.indexOf("from A")).toBeLessThan(prompt.indexOf("from B"));
    // Blind: no eval names, and no checker verdicts.
    expect(prompt).not.toContain("checker note");
    expect(seen[0]?.sharedContext).toContain("+new line");

    const bFirst = await judgePair({ ...options, runAgent: answering("1"), random: () => 0.9 });
    expect(bFirst).toMatchObject({ winner: "b", aFirst: false });
    const tie = await judgePair({ ...options, runAgent: answering("tie"), random: () => 0.9 });
    expect(tie.winner).toBe("tie");
  });

  it("shows an empty set as such, and calls two empty sets a tie without a call", async () => {
    const seen: AgentTask<unknown>[] = [];
    await judgePair({ ...options, b: [], runAgent: answering("2", seen), random: () => 0.1 });
    expect(seen[0]?.prompt).toContain("(no rough edges)");
    const none = await judgePair({
      ...options,
      a: [],
      b: [],
      runAgent: async () => {
        throw new Error("not expected");
      },
    });
    expect(none).toMatchObject({ winner: "tie", costUsd: 0, kept: { a: 0, b: 0 } });
  });

  it("records a failed call with no winner", async () => {
    const runAgent: RunAgent = async () => ({
      status: "timeout",
      output: null,
      rawText: "",
      raw: {},
      error: "timed out",
      costUsd: null,
      usage: null,
      durationMs: 1,
    });
    expect(await judgePair({ ...options, runAgent })).toMatchObject({
      winner: null,
      error: "timed out",
    });
  });
});

describe("summarizePairwise", () => {
  const result = (winner: PairwiseCase["winner"], costUsd: number | null = 0.1): PairwiseCase => ({
    id: "x",
    winner,
    aFirst: true,
    reason: null,
    error: null,
    kept: { a: 1, b: 1 },
    costUsd,
    durationMs: 1,
  });

  it("counts wins and ties, and B's win rate with ties as half", () => {
    expect(
      summarizePairwise([result("b"), result("b"), result("a"), result("tie"), result(null, null)]),
    ).toEqual({
      cases: 4,
      failed: 1,
      aWins: 1,
      bWins: 2,
      ties: 1,
      bWinRate: 2.5 / 4,
      costUsd: 0.4,
    });
  });
});
