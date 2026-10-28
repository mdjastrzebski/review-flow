import type { NormalizedFinding } from "@review-flow/core";
import { describe, expect, it } from "vitest";
import { formatFindings, wrap } from "./format.ts";

function makeFinding(overrides: Partial<NormalizedFinding>): NormalizedFinding {
  return {
    id: "F-001",
    localId: "1",
    title: "Title",
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 3,
    category: "correctness",
    severity: "medium",
    claim: "Claim text.",
    rationale: "Rationale.",
    suggestedFix: null,
    ...overrides,
  };
}

const summary = {
  base: "main",
  runDir: "/repo/.review-flow/runs/x",
  costUsd: 0.183,
  durationMs: 62_000,
};
const plain = { color: false, width: 80 };

describe("wrap", () => {
  it("wraps on word boundaries", () => {
    expect(wrap("aaa bbb ccc ddd", 7)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("keeps over-long words whole and preserves explicit newlines", () => {
    expect(wrap("abcdefghij x\ny", 5)).toEqual(["abcdefghij", "x", "y"]);
  });
});

describe("formatFindings", () => {
  it("orders findings by severity and shows the breakdown and stats", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [
          makeFinding({ id: "F-001", severity: "low" }),
          makeFinding({ id: "F-002", severity: "critical" }),
        ],
      },
      plain,
    );
    expect(text.indexOf("F-002")).toBeLessThan(text.indexOf("F-001"));
    expect(text).toContain("2 findings  1 critical · 1 low  main...HEAD · 1m 2s · $0.18");
  });

  it("shows location, claim and fix, and omits a null fix", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [
          makeFinding({ id: "F-001", lineEnd: 9, suggestedFix: "Do X." }),
          makeFinding({ id: "F-002", file: "src/b.ts" }),
        ],
      },
      plain,
    );
    expect(text).toContain("  src/a.ts:3-9\n  Claim  Claim text.\n  Fix    Do X.");
    expect(text).toContain("  src/b.ts:3\n  Claim  Claim text.\n\n");
  });

  it("says so when there are no findings", () => {
    expect(formatFindings({ ...summary, findings: [] }, plain)).toContain("No findings");
  });

  it("emits no ANSI codes without color", () => {
    const text = formatFindings({ ...summary, findings: [makeFinding({})] }, plain);
    expect(text).not.toContain("\u001b[");
  });
});
