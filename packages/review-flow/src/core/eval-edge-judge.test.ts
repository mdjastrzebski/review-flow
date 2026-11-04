import { describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import { gradesOf, judgeRoughEdges, type EdgeJudgeOutput } from "./eval-edge-judge.ts";
import type { EdgeGrade } from "./eval-rough-edge-score.ts";
import type { CheckedRoughEdge } from "./schemas.ts";

function edge(
  id: string,
  status: CheckedRoughEdge["check"]["status"] = "accurate",
): CheckedRoughEdge {
  return {
    id,
    localId: id,
    title: `title ${id}`,
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 9,
    lens: "design",
    priority: "medium",
    observation: `observation ${id}`,
    suggestion: `suggestion ${id}`,
    check: { status, note: `checker note ${id}`, priority: "medium" },
  };
}

const yes: EdgeGrade = {
  reason: "r",
  accurate: true,
  notLocal: true,
  concrete: true,
  worthPosting: true,
};

describe("gradesOf", () => {
  it("drops unknown ids and leaves an id answered twice ungraded", () => {
    const output: EdgeJudgeOutput = {
      edges: [
        { id: "R-001", ...yes },
        { id: "R-002", ...yes },
        { id: "R-002", ...yes, concrete: false },
        { id: "R-999", ...yes },
      ],
    };
    const grades = gradesOf(output, [edge("R-001"), edge("R-002")]);
    expect([...grades.keys()]).toEqual(["R-001"]);
  });
});

describe("judgeRoughEdges", () => {
  const ok = <T>(output: T): AgentResult<T> => ({
    status: "ok",
    output,
    rawText: "",
    raw: {},
    error: null,
    costUsd: 0.2,
    usage: null,
    durationMs: 5,
  });
  const options = {
    caseId: "c-1",
    change: { base: "abc", head: "`HEAD`" },
    diff: "+new line",
    cwd: "/checkout",
    model: { model: "claude-opus-5-5", effort: "high" as const },
  };

  it("doesn't call the judge without rough edges", async () => {
    const runAgent: RunAgent = async () => {
      throw new Error("not expected");
    };
    const result = await judgeRoughEdges({ ...options, edges: [], runAgent });
    expect(result).toMatchObject({ status: "ok", costUsd: 0 });
  });

  it("shows the edges without the checker's verdict, and the diff as shared context", async () => {
    let seen: AgentTask<unknown> | undefined;
    const runAgent: RunAgent = async <T>(task: AgentTask<T>) => {
      seen = task as AgentTask<unknown>;
      return ok(task.schema.parse({ edges: [{ id: "R-001", ...yes }] }));
    };
    const result = await judgeRoughEdges({ ...options, edges: [edge("R-001")], runAgent });
    expect(seen).toMatchObject({ role: "judge", cwd: "/checkout", model: "claude-opus-5-5" });
    expect(seen?.prompt).toContain("observation R-001");
    expect(seen?.prompt).not.toContain("checker note");
    expect(seen?.sharedContext).toContain("+new line");
    expect(result).toMatchObject({ status: "ok", costUsd: 0.2 });
    if (result.status === "ok") expect(result.grades.get("R-001")).toEqual(yes);
  });

  it("reports a failed call", async () => {
    const runAgent: RunAgent = async () => ({ ...ok(null), status: "timeout", error: "timed out" });
    const result = await judgeRoughEdges({ ...options, edges: [edge("R-001")], runAgent });
    expect(result).toMatchObject({ status: "failed", error: "timed out" });
  });
});
