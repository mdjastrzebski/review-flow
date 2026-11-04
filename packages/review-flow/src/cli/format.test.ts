import type { NormalizedFinding, Verdict } from "../core/index.ts";
import { describe, expect, it } from "vitest";
import { formatFindings, formatSummary, wrap } from "./format.ts";

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
  roughEdges: [],
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
    expect(text).toContain("2 findings  2 confirmed · 1 refuted  main...HEAD · 1m 2s · $0.18");
    expect(text).toContain("F-003  HIGH  confirmed (high confidence)  Title");
  });

  it("shows location, claim, verifier summary, fix and fix check", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [makeFinding({ id: "F-001", lineEnd: 9, suggestedFix: "Do X." })],
        verdicts: {
          "F-001": makeVerdict({
            fix: {
              assessment: "incomplete",
              detail: "Misses Y.",
              betterFix: "Do X and Y.",
            },
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

  it("lists refuted findings apart, without severity, fix or fix check", () => {
    const text = formatFindings(
      {
        ...summary,
        findings: [makeFinding({ id: "F-001", suggestedFix: "Do X." })],
        verdicts: {
          "F-001": makeVerdict({ verdict: "refuted", severity: "medium" }),
        },
      },
      plain,
    );
    expect(text).toContain("No findings  1 refuted  main...HEAD");
    expect(text).toContain(
      [
        "Refuted (1)  false positives: the verifier ruled these out, nothing to fix",
        "",
        "F-001  refuted (high confidence)  Title",
        "  src/a.ts:3 correctness",
        "  Why       It happens.",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("MEDIUM");
    expect(text).not.toContain("Do X.");
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
      {
        ...summary,
        findings: [makeFinding({})],
        verdicts: { "F-001": makeVerdict() },
      },
      plain,
    );
    expect(text).not.toContain("\u001b[");
  });
});

describe("formatSummary", () => {
  const options = { color: false, width: 80 };

  it("prints goal, changes, goal met, and where to look", () => {
    const text = formatSummary(
      {
        status: "ok",
        summary: {
          goal: { text: "Add b.", source: "inferred" },
          changes: ["Adds b.", "Drops c."],
          achieved: {
            verdict: "partly",
            gaps: [{ file: "a.ts", line: 4, detail: "No test." }],
            extras: [],
          },
          lookAt: [{ file: "b.ts", line: null, detail: "New pattern." }],
        },
      },
      "own",
      options,
    );
    expect(text.split("\n")).toEqual([
      "",
      "Summary",
      "  Goal      Add b. (inferred)",
      "",
      "  Changes   - Adds b.",
      "            - Drops c.",
      "",
      "  Goal met  partly",
      "",
      "  Gaps      - a.ts:4 No test.",
      "",
      "  Look at   - b.ts New pattern.",
    ]);
  });

  it("says when the summary is missing", () => {
    expect(formatSummary({ status: "failed", error: "timeout: slow" }, "own", options)).toContain(
      "Missing: the summarizer failed (timeout: slow).",
    );
  });
});
