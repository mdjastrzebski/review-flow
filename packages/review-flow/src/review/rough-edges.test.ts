import { describe, expect, it } from "vitest";
import { normalizeRoughEdges, MAX_ROUGH_EDGES } from "./normalize.ts";
import {
  applyChecks,
  buildRoughEdgeCheckerPrompt,
  describeRoughEdges,
  keptRoughEdges,
} from "./rough-edges.ts";
import type { NormalizedRoughEdge, RoughEdge } from "./schemas.ts";

const repo = "/repo";

function makeEdge(overrides: Partial<RoughEdge> = {}): RoughEdge {
  return {
    localId: "1",
    title: "Hidden ordering",
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 9,
    lens: "design",
    priority: "medium",
    observation: "Reads state set two calls earlier.",
    suggestion: "Pass it as an argument.",
    ...overrides,
  };
}

const normalized = (id: string): NormalizedRoughEdge => ({ id, ...makeEdge({ localId: id }) });

describe("normalizeRoughEdges", () => {
  it("assigns R-001… ids, makes paths relative, and swaps reversed ranges", () => {
    const { roughEdges, notes } = normalizeRoughEdges(
      [makeEdge({ file: "/repo/src/a.ts", lineStart: 9, lineEnd: 3 }), makeEdge()],
      repo,
    );
    expect(roughEdges.map((e) => e.id)).toEqual(["R-001", "R-002"]);
    expect(roughEdges[0]).toMatchObject({ file: "src/a.ts", lineStart: 3, lineEnd: 9 });
    expect(notes).toHaveLength(1);
  });

  it("caps the list and notes it", () => {
    const many = Array.from({ length: MAX_ROUGH_EDGES + 2 }, () => makeEdge());
    const { roughEdges, notes } = normalizeRoughEdges(many, repo);
    expect(roughEdges).toHaveLength(MAX_ROUGH_EDGES);
    expect(notes).toHaveLength(1);
  });
});

describe("buildRoughEdgeCheckerPrompt", () => {
  it("lists each edge with its id, location, observation and suggestion", () => {
    const prompt = buildRoughEdgeCheckerPrompt(
      "{{base}} {{head}}\n{{items}}",
      [normalized("R-001")],
      { base: "main", head: "`HEAD`" },
    );
    expect(prompt).toContain("R-001: Hidden ordering");
    expect(prompt).toContain("`src/a.ts:3-9` · lens: design · reviewer priority: medium");
    expect(prompt).toContain("Reads state set two calls earlier.");
    expect(prompt).toContain("Pass it as an argument.");
  });
});

describe("applyChecks", () => {
  const edges = [normalized("R-001"), normalized("R-002"), normalized("R-003")];

  it("pairs checks by id; a missing or repeated answer is unclear", () => {
    const checked = applyChecks(
      edges,
      {
        checks: [
          { localId: "R-001", status: "accurate", note: "ok", priority: "high" },
          { localId: "R-003", status: "inaccurate", note: "a", priority: "high" },
          { localId: "R-003", status: "accurate", note: "b", priority: "high" },
        ],
      },
      null,
    );
    expect(checked.map((e) => e.check.status)).toEqual(["accurate", "unclear", "unclear"]);
    expect(checked[1]!.check.note).toContain("no answer");
    expect(checked[2]!.check.note).toContain("more than once");
  });

  it("copies the checker's priority; without a usable answer it keeps the reviewer's", () => {
    const withPriority = edges.map((edge) => ({ ...edge, priority: "low" as const }));
    const checked = applyChecks(
      withPriority,
      { checks: [{ localId: "R-001", status: "accurate", note: "ok", priority: "high" }] },
      null,
    );
    expect(checked.map((e) => e.check.priority)).toEqual(["high", "low", "low"]);
    const failed = applyChecks(withPriority, null, "timeout");
    expect(failed.map((e) => e.check.priority)).toEqual(["low", "low", "low"]);
  });

  it("marks all unclear with the failure when the checker produced nothing", () => {
    const checked = applyChecks(edges, null, "timeout: slow");
    expect(checked.every((e) => e.check.status === "unclear")).toBe(true);
    expect(checked[0]!.check.note).toContain("timeout: slow");
  });

  it("keeps all but inaccurate edges", () => {
    const checked = applyChecks(
      edges.slice(0, 2),
      {
        checks: [
          { localId: "R-001", status: "inaccurate", note: "x", priority: "low" },
          { localId: "R-002", status: "accurate", note: "y", priority: "low" },
        ],
      },
      null,
    );
    expect(keptRoughEdges(checked).map((e) => e.id)).toEqual(["R-002"]);
  });
});

describe("keptRoughEdges order", () => {
  it("sorts high, medium, low, keeping reviewer order on ties", () => {
    const edges = ["low", "high", "medium", "high", "low"].map((priority, i) => ({
      ...normalized(`R-00${i + 1}`),
      check: { status: "accurate" as const, note: "n", priority: priority as "high" },
    }));
    expect(keptRoughEdges(edges).map((e) => e.id)).toEqual([
      "R-002",
      "R-004",
      "R-003",
      "R-001",
      "R-005",
    ]);
  });
});

describe("describeRoughEdges", () => {
  it("shows the reviewer's priority", () => {
    expect(describeRoughEdges([{ ...normalized("R-001"), priority: "high" }])).toContain(
      "reviewer priority: high",
    );
  });
});
