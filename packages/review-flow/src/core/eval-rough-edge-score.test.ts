import { describe, expect, it } from "vitest";
import { isPostable, tallyEdgeJudge, type EdgeGrade } from "./eval-rough-edge-score.ts";
import type { CheckedRoughEdge } from "./schemas.ts";

const grade = (overrides: Partial<EdgeGrade> = {}): EdgeGrade => ({
  reason: "r",
  accurate: true,
  notLocal: true,
  concrete: true,
  worthPosting: true,
  ...overrides,
});

describe("isPostable", () => {
  it("needs a yes to every question", () => {
    expect(isPostable(grade())).toBe(true);
    expect(isPostable(grade({ worthPosting: false }))).toBe(false);
  });
});

describe("tallyEdgeJudge", () => {
  const edge = (id: string, status: CheckedRoughEdge["check"]["status"]): CheckedRoughEdge => ({
    id,
    localId: id,
    title: id,
    file: "a.ts",
    lineStart: 1,
    lineEnd: 2,
    lens: "design",
    priority: "medium",
    observation: "o",
    suggestion: "s",
    check: { status, note: "n", priority: "medium" },
  });
  const edges = [
    edge("R-001", "accurate"),
    edge("R-002", "unclear"),
    edge("R-003", "inaccurate"),
    edge("R-004", "accurate"),
  ];

  it("counts postable ones by the checker's verdict, and the no answers", () => {
    const grades = new Map([
      ["R-001", grade()],
      ["R-002", grade({ notLocal: false, worthPosting: false })],
      ["R-003", grade()],
      // R-004 ungraded: not counted.
    ]);
    const tally = tallyEdgeJudge(edges, { status: "ok", grades, costUsd: 0.3, durationMs: 1 });
    expect(tally).toEqual({
      status: "ok",
      error: null,
      costUsd: 0.3,
      durationMs: 1,
      kept: 2,
      keptPostable: 1,
      dropped: 1,
      droppedPostable: 1,
      no: { accurate: 0, notLocal: 1, concrete: 0, worthPosting: 1 },
    });
  });

  it("counts nothing for a failed call", () => {
    const tally = tallyEdgeJudge(edges, {
      status: "failed",
      error: "boom",
      costUsd: null,
      durationMs: 0,
    });
    expect(tally).toMatchObject({ status: "failed", error: "boom", kept: 0, dropped: 0 });
  });
});
