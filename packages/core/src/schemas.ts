import { z } from "zod";

// No optional fields anywhere: absent values are `null`.

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Category = z.enum([
  "correctness",
  "security",
  "performance",
  "reliability",
  "maintainability",
  "tests",
  "other",
]);
export type Category = z.infer<typeof Category>;

const LineNumber = z.int().positive();

export const Finding = z.strictObject({
  localId: z.string(),
  title: z.string(),
  file: z.string(),
  lineStart: LineNumber,
  lineEnd: LineNumber,
  category: Category,
  severity: Severity,
  claim: z.string(),
  rationale: z.string(),
  /** Short description of the fix (≤ 3 sentences or a snippet ≤ 10 lines), not a patch. */
  suggestedFix: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewOutput = z.strictObject({
  findings: z.array(Finding),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const Evidence = z.strictObject({
  kind: z.enum(["code_ref", "reasoning"]),
  file: z.string().nullable(),
  line: LineNumber.nullable(),
  detail: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const FixAssessment = z.strictObject({
  assessment: z.enum(["sound", "flawed", "incomplete", "not_applicable"]),
  /** Why; what breaks or what's missing. */
  detail: z.string(),
  /** Short alternative when flawed/incomplete, or when the reviewer gave none. */
  betterFix: z.string().nullable(),
});
export type FixAssessment = z.infer<typeof FixAssessment>;

export const Verdict = z.strictObject({
  verdict: z.enum(["confirmed", "refuted", "inconclusive"]),
  severity: Severity,
  confidence: Confidence,
  fixCost: z.enum(["trivial", "small", "medium", "large"]),
  evidence: z.array(Evidence),
  summary: z.string(),
  fix: FixAssessment,
});
export type Verdict = z.infer<typeof Verdict>;

/** A reviewer finding after normalization: stable run-wide id assigned. */
export type NormalizedFinding = Finding & { id: string };
