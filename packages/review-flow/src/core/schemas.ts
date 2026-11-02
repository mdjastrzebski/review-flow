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

/** A place in the code the summary points at; `line` is null when no single line fits. */
export const CodeRef = z.strictObject({
  file: z.string(),
  line: LineNumber.nullable(),
  detail: z.string(),
});
export type CodeRef = z.infer<typeof CodeRef>;

/** summary.json: a short account of the change for the human reviewer (spec 7). */
export const Summary = z.strictObject({
  goal: z.strictObject({
    text: z.string(),
    /** `stated` in the PR description or commit messages, else `inferred` from the diff. */
    source: z.enum(["stated", "inferred"]),
  }),
  /** Behavior changes, not a file list. */
  changes: z.array(z.string()),
  /** Judges the change against its goal only, not its correctness. */
  achieved: z.strictObject({
    verdict: z.enum(["yes", "mostly", "partly", "unclear"]),
    /** Parts of the stated goal missing from the diff. */
    gaps: z.array(CodeRef),
    /** Parts of the diff outside the goal. */
    extras: z.array(CodeRef),
  }),
  /** Places that need human judgment. */
  lookAt: z.array(CodeRef),
});
export type Summary = z.infer<typeof Summary>;
