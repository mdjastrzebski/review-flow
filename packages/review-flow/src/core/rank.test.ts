import { describe, expect, it } from "vitest";
import { applyVerdictRules, rankFindings, type RankedItem } from "./rank.ts";
import type { Evidence, NormalizedFinding, Verdict } from "./schemas.ts";

const codeRef: Evidence = { kind: "code_ref", file: "src/a.ts", line: 3, detail: "here" };
const reasoning: Evidence = { kind: "reasoning", file: null, line: null, detail: "because" };

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    verdict: "confirmed",
    severity: "medium",
    confidence: "medium",
    fixCost: "small",
    evidence: [codeRef],
    summary: "summary",
    fix: { assessment: "sound", detail: "ok", betterFix: null },
    ...overrides,
  };
}

function makeItem(id: string, overrides: Partial<Verdict>): RankedItem {
  const finding: NormalizedFinding = {
    id,
    localId: id,
    title: id,
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 1,
    category: "correctness",
    severity: "low",
    claim: "claim",
    rationale: "rationale",
    suggestedFix: null,
  };
  return { finding, verdict: makeVerdict(overrides) };
}

describe("applyVerdictRules", () => {
  it("keeps confirmed when there is a code_ref with file and line", () => {
    expect(applyVerdictRules(makeVerdict()).verdict).toBe("confirmed");
  });

  it("downgrades confirmed without any code_ref to inconclusive", () => {
    const result = applyVerdictRules(makeVerdict({ evidence: [reasoning] }));
    expect(result.verdict).toBe("inconclusive");
  });

  it("downgrades confirmed with no evidence at all", () => {
    expect(applyVerdictRules(makeVerdict({ evidence: [] })).verdict).toBe("inconclusive");
  });

  it("does not count a code_ref missing file or line", () => {
    const evidence: Evidence[] = [
      { ...codeRef, file: null },
      { ...codeRef, line: null },
    ];
    expect(applyVerdictRules(makeVerdict({ evidence })).verdict).toBe("inconclusive");
  });

  it("forces fix.assessment to not_applicable when refuted", () => {
    const result = applyVerdictRules(makeVerdict({ verdict: "refuted" }));
    expect(result.fix.assessment).toBe("not_applicable");
    expect(result.fix.detail).toBe("ok");
  });

  it("leaves inconclusive verdicts untouched", () => {
    const input = makeVerdict({ verdict: "inconclusive", evidence: [] });
    expect(applyVerdictRules(input)).toEqual(input);
  });

  it("does not mutate its input", () => {
    const input = makeVerdict({ evidence: [] });
    applyVerdictRules(input);
    expect(input.verdict).toBe("confirmed");
  });
});

describe("rankFindings", () => {
  it("orders confirmed → inconclusive → refuted regardless of severity", () => {
    const ranked = rankFindings([
      makeItem("refuted", { verdict: "refuted", severity: "critical" }),
      makeItem("inconclusive", { verdict: "inconclusive", severity: "critical" }),
      makeItem("confirmed", { verdict: "confirmed", severity: "low" }),
    ]);
    expect(ranked.map((item) => item.finding.id)).toEqual(["confirmed", "inconclusive", "refuted"]);
  });

  it("orders by verifier severity within a verdict", () => {
    const ranked = rankFindings([
      makeItem("low", { severity: "low" }),
      makeItem("critical", { severity: "critical" }),
      makeItem("medium", { severity: "medium" }),
      makeItem("high", { severity: "high" }),
    ]);
    expect(ranked.map((item) => item.finding.id)).toEqual(["critical", "high", "medium", "low"]);
  });

  it("orders by confidence when verdict and severity tie", () => {
    const ranked = rankFindings([
      makeItem("low", { confidence: "low" }),
      makeItem("high", { confidence: "high" }),
      makeItem("medium", { confidence: "medium" }),
    ]);
    expect(ranked.map((item) => item.finding.id)).toEqual(["high", "medium", "low"]);
  });

  it("is stable for full ties and does not mutate its input", () => {
    const items = [makeItem("a", {}), makeItem("b", {})];
    expect(rankFindings(items).map((item) => item.finding.id)).toEqual(["a", "b"]);
    const reversed = items.toReversed();
    rankFindings(reversed);
    expect(reversed.map((item) => item.finding.id)).toEqual(["b", "a"]);
  });
});
