import type { Confidence, NormalizedFinding, Severity, Verdict } from "./schemas.ts";

export interface RankedItem {
  finding: NormalizedFinding;
  verdict: Verdict;
}

/** A code_ref only counts as evidence when it points at a concrete file and line. */
function hasCodeRef(verdict: Verdict): boolean {
  return verdict.evidence.some((e) => e.kind === "code_ref" && e.file !== null && e.line !== null);
}

/**
 * Rules enforced in code rather than trusted to the verifier:
 * - confirmed without code_ref evidence is downgraded to inconclusive;
 * - refuted claims have nothing to fix, so fix.assessment is not_applicable.
 */
export function applyVerdictRules(verdict: Verdict): Verdict {
  let result = verdict;
  if (result.verdict === "confirmed" && !hasCodeRef(result)) {
    result = { ...result, verdict: "inconclusive" };
  }
  if (result.verdict === "refuted" && result.fix.assessment !== "not_applicable") {
    result = { ...result, fix: { ...result.fix, assessment: "not_applicable" } };
  }
  return result;
}

const VERDICT_ORDER: Record<Verdict["verdict"], number> = {
  confirmed: 0,
  inconclusive: 1,
  refuted: 2,
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CONFIDENCE_ORDER: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Confirmed → inconclusive → refuted; then by (verifier-assessed) severity, then confidence. */
export function rankFindings(items: readonly RankedItem[]): RankedItem[] {
  return items.toSorted(
    (a, b) =>
      VERDICT_ORDER[a.verdict.verdict] - VERDICT_ORDER[b.verdict.verdict] ||
      SEVERITY_ORDER[a.verdict.severity] - SEVERITY_ORDER[b.verdict.severity] ||
      CONFIDENCE_ORDER[a.verdict.confidence] - CONFIDENCE_ORDER[b.verdict.confidence],
  );
}
