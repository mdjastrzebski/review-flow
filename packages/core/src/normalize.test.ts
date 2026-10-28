import { describe, expect, it } from "vitest";
import { findingId, MAX_FINDINGS, normalizeFindings } from "./normalize.ts";
import type { Finding } from "./schemas.ts";

const repo = "/repo";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    localId: "1",
    title: "t",
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 2,
    category: "correctness",
    severity: "medium",
    claim: "c",
    rationale: "r",
    suggestedFix: null,
    ...overrides,
  };
}

describe("normalizeFindings", () => {
  it("assigns F-001… ids in reviewer order", () => {
    const { findings } = normalizeFindings(
      { findings: [makeFinding({ localId: "a" }), makeFinding({ localId: "b" })] },
      repo,
    );
    expect(findings.map((f) => [f.id, f.localId])).toEqual([
      ["F-001", "a"],
      ["F-002", "b"],
    ]);
  });

  it("pads ids to three digits", () => {
    expect(findingId(0)).toBe("F-001");
    expect(findingId(14)).toBe("F-015");
  });

  it("caps the list and notes it", () => {
    const many = Array.from({ length: MAX_FINDINGS + 3 }, () => makeFinding());
    const { findings, notes } = normalizeFindings({ findings: many }, repo);
    expect(findings).toHaveLength(MAX_FINDINGS);
    expect(notes).toHaveLength(1);
  });

  it("makes paths repo-relative", () => {
    const { findings } = normalizeFindings(
      { findings: [makeFinding({ file: "/repo/src/a.ts" }), makeFinding({ file: "./src/b.ts" })] },
      repo,
    );
    expect(findings.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("leaves paths outside the repo untouched", () => {
    const { findings } = normalizeFindings(
      { findings: [makeFinding({ file: "/etc/hosts" })] },
      repo,
    );
    expect(findings[0]?.file).toBe("/etc/hosts");
  });

  it("swaps a reversed line range and notes it", () => {
    const { findings, notes } = normalizeFindings(
      { findings: [makeFinding({ lineStart: 9, lineEnd: 3 })] },
      repo,
    );
    expect([findings[0]?.lineStart, findings[0]?.lineEnd]).toEqual([3, 9]);
    expect(notes).toEqual(["F-001: swapped reversed line range 9-3."]);
  });
});
