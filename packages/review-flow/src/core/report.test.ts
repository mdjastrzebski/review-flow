import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "./models.ts";
import { renderReport, type ReportInput } from "./report.ts";
import type { NormalizedFinding, Summary, Verdict } from "./schemas.ts";
import { MAX_FIX_LINES } from "./verify.ts";

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    id: "F-001",
    localId: "1",
    title: "Race in cache invalidation",
    file: "src/cache.ts",
    lineStart: 42,
    lineEnd: 57,
    category: "correctness",
    severity: "critical",
    claim: "Two writers can interleave.",
    rationale: "RATIONALE_SENTINEL",
    suggestedFix: "Use a generation counter.",
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    verdict: "confirmed",
    severity: "high",
    confidence: "high",
    fixCost: "small",
    evidence: [{ kind: "code_ref", file: "src/cache.ts", line: 48, detail: "no lock held" }],
    summary: "The race is real.",
    fix: {
      assessment: "incomplete",
      detail: "misses invalidateAll path",
      betterFix: "Bump it too.",
    },
    ...overrides,
  };
}

const input: ReportInput = {
  harness: "claude",
  models: DEFAULT_MODELS.claude,
  base: { ref: "main", sha: "0123456789abcdef" },
  head: { sha: "fedcba9876543210" },
  durationMs: 125_000,
  costUsd: 1.234,
  summary: null,
  findings: [makeFinding()],
  verdicts: { "F-001": makeVerdict() },
};

function render(findings: NormalizedFinding[], verdicts: Record<string, Verdict>): string {
  return renderReport({ ...input, findings, verdicts });
}

const goodSummary: Summary = {
  goal: { text: "Make cache invalidation safe.", source: "inferred" },
  changes: ["Writers take a lock.", "Readers <retry> once."],
  achieved: {
    verdict: "mostly",
    gaps: [{ file: "src/cache.ts", line: 90, detail: "invalidateAll has no lock." }],
    extras: [{ file: "src/log.ts", line: null, detail: "Logging format changed." }],
  },
  lookAt: [{ file: "src/lock.ts", line: 3, detail: "New lock pattern." }],
};

describe("renderReport summary", () => {
  it("puts the summary between the header and the findings", () => {
    const report = renderReport({ ...input, summary: { status: "ok", summary: goodSummary } });
    expect(report).toContain("- **Summarizer:** claude-sonnet-5-5 (effort: medium)");
    expect(report).toContain(
      [
        "## Summary",
        "**Goal:** Make cache invalidation safe. _(inferred)_",
        "- Writers take a lock.\n- Readers &lt;retry> once.",
        "**Goal met:** mostly\n\n- Gap: `src/cache.ts:90` — invalidateAll has no lock.\n- Extra: `src/log.ts` — Logging format changed.",
        "**Look at:**\n\n- `src/lock.ts:3` — New lock pattern.",
        "**1 finding:**",
      ].join("\n\n"),
    );
  });

  it("says when the summarizer failed", () => {
    const report = renderReport({
      ...input,
      summary: { status: "failed", error: "timeout: slow" },
    });
    expect(report).toContain("Summary missing: the summarizer failed (timeout: slow).");
  });

  it("leaves out the findings and their models when Find was skipped", () => {
    const report = renderReport({
      ...input,
      summary: { status: "ok", summary: goodSummary },
      findings: null,
    });
    expect(report).toContain("## Summary");
    expect(report).not.toContain("Reviewer");
    expect(report).not.toContain("finding");
  });
});

describe("renderReport", () => {
  it("has a header with harness, models, base/head, duration and cost", () => {
    const report = renderReport(input);
    expect(report).toContain("# Review: main...HEAD");
    expect(report).toContain("- **Harness:** claude");
    expect(report).toContain("- **Reviewer:** claude-sonnet-5-5 (effort: high)");
    expect(report).toContain("- **Verifier:** claude-sonnet-5-5 (effort: high)");
    expect(report).toContain("- **Base:** `main` (`0123456`) · **Head:** `fedcba9`");
    expect(report).toContain("- **Duration:** 2m 5s · **Cost:** $1.23");
  });

  it("omits the cost when unknown", () => {
    const report = renderReport({ ...input, costUsd: null });
    expect(report).toContain("- **Duration:** 2m 5s\n");
    expect(report).not.toContain("Cost");
  });

  it("renders a finding with checkbox heading, evidence, fix check and severity change", () => {
    expect(renderReport(input)).toContain(
      [
        "### [ ] F-001 · high · confirmed (high) · `src/cache.ts:42-57`",
        "**Race in cache invalidation**",
        "**Claim:** Two writers can interleave.",
        "**Verifier:** The race is real.",
        "**Evidence:**\n\n- `src/cache.ts:48` — no lock held",
        "**Suggested fix:** Use a generation counter. — verifier: **incomplete** (misses invalidateAll path)",
        "**Better fix:** Bump it too.",
        "correctness · reviewer severity: critical → verifier: high · fix cost: small",
      ].join("\n\n"),
    );
  });

  it("never includes the reviewer's rationale", () => {
    expect(renderReport(input)).not.toContain("RATIONALE_SENTINEL");
  });

  it("ranks findings in the summary table and groups them by verdict", () => {
    const report = render(
      [
        makeFinding({ id: "F-001", title: "refuted one" }),
        makeFinding({ id: "F-002", title: "low | piped" }),
        makeFinding({ id: "F-003", title: "inconclusive one" }),
        makeFinding({ id: "F-004", title: "critical one" }),
      ],
      {
        "F-001": makeVerdict({ verdict: "refuted", severity: "critical" }),
        "F-002": makeVerdict({ severity: "low" }),
        "F-003": makeVerdict({ verdict: "inconclusive", evidence: [] }),
        "F-004": makeVerdict({ severity: "critical" }),
      },
    );
    expect(report).toContain("**4 findings:** 2 confirmed · 1 inconclusive · 1 refuted");
    const rows = report.split("\n").filter((line) => /^\| F-\d{3} /.test(line));
    expect(rows.map((row) => row.slice(2, 7))).toEqual(["F-004", "F-002", "F-003", "F-001"]);
    expect(rows[1]).toContain("| low \\| piped |");

    const order = [
      "## Confirmed (2)",
      "### [ ] F-004",
      "### [ ] F-002",
      "## Inconclusive (1)",
      "### [ ] F-003",
      "<summary>Refuted (1)</summary>",
      "### [ ] F-001",
    ].map((s) => report.indexOf(s));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(report).toContain("**Evidence:** none");
  });

  it("collapses refuted findings at the end, without fix lines", () => {
    const report = render([makeFinding()], {
      "F-001": makeVerdict({ verdict: "refuted" }),
    });
    const details = report.slice(report.indexOf("<details>"));
    expect(details).toContain("### [ ] F-001 · high · refuted (high)");
    expect(details.trimEnd().endsWith("</details>")).toBe(true);
    expect(report).not.toContain("Suggested fix");
    expect(report).not.toContain("## Confirmed");
  });

  it("flags a suggested fix the verifier only saw truncated", () => {
    const long = Array.from({ length: MAX_FIX_LINES + 2 }, (_, i) => `line ${i}`).join("\n");
    const report = render([makeFinding({ suggestedFix: long })], { "F-001": makeVerdict() });
    expect(report).toContain("**Suggested fix (truncated for the verifier):**\n\n```\nline 0\n");
    expect(report).toContain(`line ${MAX_FIX_LINES + 1}\n\`\`\`\n\n— verifier: **incomplete**`);
  });

  it("renders multi-line claims and verifier summaries as prose, not code", () => {
    const claim = "First paragraph.\n\nSecond paragraph.";
    const summary = "It holds.\nSee the lock.";
    const report = render([makeFinding({ claim })], {
      "F-001": makeVerdict({ summary }),
    });
    expect(report).toContain(
      `**Claim:**\n\n${claim}\n\n**Verifier:**\n\n${summary}\n\n**Evidence:**`,
    );
  });

  it("keeps agent text from breaking single-line Markdown or the refuted section", () => {
    const report = render(
      [makeFinding({ title: "Bad **bold** and\n`a**b`", suggestedFix: "Use `Map<K, V>` not <b>" })],
      {
        "F-001": makeVerdict({
          evidence: [
            { kind: "code_ref", file: "src/a.ts", line: 1, detail: "first\n\nsecond </details>" },
            { kind: "reasoning", file: null, line: null, detail: "uses `Array<T>`\nhere" },
          ],
          fix: { assessment: "incomplete", detail: "misses\n<x>", betterFix: null },
        }),
      },
    );
    expect(report).toContain("**Bad \\*\\*bold\\*\\* and `a**b`**");
    expect(report).toContain("- `src/a.ts:1` — first second &lt;/details>");
    expect(report).toContain("- uses `Array<T>` here");
    expect(report).toContain("**Suggested fix:** Use `Map<K, V>` not &lt;b>");
    expect(report).toContain("verifier: **incomplete** (misses &lt;x>)");
  });

  it("keeps a fix that brings its own code fence as-is", () => {
    const fix = "Guard it:\n```ts\nif (x) return;\n```";
    const report = render([makeFinding({ suggestedFix: fix })], { "F-001": makeVerdict() });
    expect(report).toContain(`**Suggested fix:**\n\n${fix}\n\n— verifier:`);
  });

  it("says when no fix was suggested and omits the check when not assessed", () => {
    const report = render([makeFinding({ suggestedFix: null })], {
      "F-001": makeVerdict({
        fix: { assessment: "not_applicable", detail: "n/a", betterFix: "Do Y." },
      }),
    });
    expect(report).toContain("**Suggested fix:** none\n\n**Better fix:** Do Y.");
  });

  it("says so when there are no findings", () => {
    const report = render([], {});
    expect(report).toContain("No findings.");
    expect(report).not.toContain("| ID |");
  });

  it("throws on a finding without a verdict", () => {
    expect(() => render([makeFinding()], {})).toThrow("No verdict for F-001");
  });
});
