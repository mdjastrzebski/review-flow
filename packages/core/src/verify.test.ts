import { describe, expect, it } from "vitest";
import { loadPrompt } from "./prompts.ts";
import { applyVerdictRules } from "./rank.ts";
import type { NormalizedFinding, Verdict } from "./schemas.ts";
import { buildVerifierPrompt, MAX_FIX_CHARS, MAX_FIX_LINES, truncateFix } from "./verify.ts";

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    id: "F-001",
    localId: "1",
    title: "Off-by-one in loop",
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 7,
    category: "correctness",
    severity: "high",
    claim: "CLAIM_SENTINEL: the last element is skipped.",
    rationale: "RATIONALE_SENTINEL: I read the loop bound.",
    suggestedFix: "FIX_SENTINEL: use <= instead of <.",
    ...overrides,
  };
}

const context = { base: "main", diff: "DIFF_SENTINEL" };
const template = await loadPrompt("verifier");
const build = (finding: NormalizedFinding) => buildVerifierPrompt(template, finding, context);

describe("buildVerifierPrompt", () => {
  it("includes title, location, claim, fix, base and diff", () => {
    const prompt = build(makeFinding());
    expect(prompt).toContain("Off-by-one in loop");
    expect(prompt).toContain("`src/a.ts:3-7`");
    expect(prompt).toContain("CLAIM_SENTINEL");
    expect(prompt).toContain("FIX_SENTINEL");
    expect(prompt).toContain("`main`");
    expect(prompt).toContain("DIFF_SENTINEL");
  });

  it("never includes the reviewer's rationale", () => {
    expect(build(makeFinding())).not.toContain("RATIONALE_SENTINEL");
  });

  it("does not depend on the reviewer's severity, category, rationale or localId", () => {
    const a = build(makeFinding());
    const b = build(
      makeFinding({ severity: "low", category: "tests", rationale: "other", localId: "9" }),
    );
    expect(a).toBe(b);
  });

  it("places the fix after the claim and the claim step before the fix step", () => {
    const prompt = build(makeFinding());
    const claimAt = prompt.indexOf("CLAIM_SENTINEL");
    expect(prompt.indexOf("## Step 1")).toBeLessThan(claimAt);
    expect(claimAt).toBeLessThan(prompt.indexOf("## Step 2"));
    expect(prompt.indexOf("## Step 2")).toBeLessThan(prompt.indexOf("FIX_SENTINEL"));
  });

  it("says so when there is no suggested fix", () => {
    expect(build(makeFinding({ suggestedFix: null }))).toContain("No fix was suggested.");
  });

  it("truncates an over-long suggested fix", () => {
    const fix = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const prompt = build(makeFinding({ suggestedFix: fix }));
    expect(prompt).toContain(`line ${MAX_FIX_LINES}…`);
    expect(prompt).not.toContain(`line ${MAX_FIX_LINES + 1}`);
  });

  it("fences a diff containing a closing fence so it can't end early", () => {
    const diff = " ```\n+added";
    const prompt = buildVerifierPrompt(template, makeFinding(), { base: "main", diff });
    expect(prompt).toContain(`\`\`\`\`diff\n${diff}\n\`\`\`\``);
  });

  it("uses a single-line location when the range is one line", () => {
    expect(build(makeFinding({ lineEnd: 3 }))).toContain("`src/a.ts:3`");
  });
});

describe("truncateFix", () => {
  it("leaves a short fix alone", () => {
    expect(truncateFix("  Do X.  ")).toEqual({ text: "Do X.", truncated: false });
  });

  it("caps lines and characters and flags it", () => {
    const byLines = truncateFix("a\n".repeat(MAX_FIX_LINES + 1));
    expect(byLines.truncated).toBe(true);
    expect(byLines.text.split("\n")).toHaveLength(MAX_FIX_LINES);

    const byChars = truncateFix("x".repeat(MAX_FIX_CHARS + 50));
    expect(byChars.truncated).toBe(true);
    expect(byChars.text).toBe(`${"x".repeat(MAX_FIX_CHARS)}… [truncated]`);
  });
});

describe("refuted verdicts", () => {
  it("get fix.assessment = not_applicable", () => {
    const verdict: Verdict = {
      verdict: "refuted",
      severity: "low",
      confidence: "high",
      fixCost: "trivial",
      evidence: [{ kind: "code_ref", file: "src/a.ts", line: 3, detail: "guarded" }],
      summary: "s",
      fix: { assessment: "sound", detail: "d", betterFix: null },
    };
    expect(applyVerdictRules(verdict).fix.assessment).toBe("not_applicable");
  });
});
