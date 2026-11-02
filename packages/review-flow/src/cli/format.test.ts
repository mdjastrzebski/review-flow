import type { NormalizedFinding, Verdict } from "../core/index.ts";
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

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    verdict: "confirmed",
    severity: "medium",
    confidence: "high",
    fixCost: "small",
    evidence: [{ kind: "code_ref", file: "src/a.ts", line: 3, detail: "here" }],
    summary: "It happens.",
    fix: { assessment: "sound", detail: "Works.", betterFix: null },
    ...overrides,
  };
}

const summary = {
  base: "main",
  reportPath: "/repo/.review-flow/runs/x/report.md",
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
  it("ranks by verdict, then verifier severity, and shows the breakdown and stats", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [
          makeFinding({ id: "F-001", severity: "critical" }),
          makeFinding({ id: "F-002" }),
          makeFinding({ id: "F-003" }),
        ],
        verdicts: {
          "F-001": makeVerdict({ verdict: "refuted", severity: "critical" }),
          "F-002": makeVerdict({ severity: "low" }),
          "F-003": makeVerdict({ severity: "high" }),
        },
      },
      plain,
    );
    const order = ["F-003", "F-002", "F-001"].map((id) => text.indexOf(id));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(text).toContain("3 findings  2 confirmed · 1 refuted  main...HEAD · 1m 2s · $0.18");
    expect(text).toContain("F-003  HIGH  confirmed (high confidence)  Title");
  });

  it("shows location, claim, verifier summary, fix and fix check", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [makeFinding({ id: "F-001", lineEnd: 9, suggestedFix: "Do X." })],
        verdicts: {
          "F-001": makeVerdict({
            fix: { assessment: "incomplete", detail: "Misses Y.", betterFix: "Do X and Y." },
          }),
        },
      },
      plain,
    );
    expect(text).toContain(
      [
        "  src/a.ts:3-9 correctness",
        "  Claim     Claim text.",
        "  Verifier  It happens.",
        "  Fix       Do X.",
        "  Fix check incomplete: Misses Y.",
        "  Better    Do X and Y.",
      ].join("\n"),
    );
  });

  it("omits a null fix and the fix check for refuted findings", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [makeFinding({ id: "F-001" })],
        verdicts: { "F-001": makeVerdict({ verdict: "refuted" }) },
      },
      plain,
    );
    expect(text).toContain("  Verifier  It happens.\n\n");
  });

  it("omits the cost when unknown", () => {
    const text = formatFindings({ ...summary, costUsd: null, findings: [], verdicts: {} }, plain);
    expect(text).toContain("main...HEAD · 1m 2s\n");
  });

  it("says so when there are no findings", () => {
    expect(formatFindings({ ...summary, findings: [], verdicts: {} }, plain)).toContain(
      "No findings",
    );
  });

  it("emits no ANSI codes without color", () => {
    const text = formatFindings(
      { ...summary, findings: [makeFinding({})], verdicts: { "F-001": makeVerdict() } },
      plain,
    );
    expect(text).not.toContain("\u001b[");
  });
});
