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

/** How much a rough edge will cost the next editor; triage only, never a severity. */
export const Priority = z.enum(["high", "medium", "low"]);
export type Priority = z.infer<typeof Priority>;

export const Lens = z.enum(["structure", "design", "testability"]);
export type Lens = z.infer<typeof Lens>;

/** Not a defect: the code works, but design makes it harder to understand or evolve (spec 5). */
export const RoughEdge = z.strictObject({
  localId: z.string(),
  title: z.string(),
  file: z.string(),
  lineStart: LineNumber,
  lineEnd: LineNumber,
  lens: Lens,
  /** The reviewer's proposal; the checker's `check.priority` is the final one. */
  priority: Priority,
  /** What is in the code, and why it is hard to follow or change. */
  observation: z.string(),
  /** A concrete change, described, not a patch. */
  suggestion: z.string(),
});
export type RoughEdge = z.infer<typeof RoughEdge>;

/** The reviewer's answer when rough edges are off: findings only. */
export const FindingsOutput = z.strictObject({
  findings: z.array(Finding),
});
export type FindingsOutput = z.infer<typeof FindingsOutput>;

/** The reviewer's answer when rough edges are on; the list is required, but may be empty. */
export const ReviewOutput = z.strictObject({
  findings: z.array(Finding),
  roughEdges: z.array(RoughEdge),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/**
 * ReviewOutput for parsing the reviewer's answer. It emits the same JSON Schema, but a missing
 * `roughEdges` list counts as empty and invalid edges are dropped, so a bad edge can't lose the
 * findings. `notes()` describes what the latest parse dropped.
 */
export function lenientReviewOutput(): { schema: z.ZodType<ReviewOutput>; notes: () => string[] } {
  let notes: string[] = [];
  const schema = z.preprocess((value) => {
    notes = [];
    if (typeof value !== "object" || value === null || !("findings" in value)) return value;
    const { roughEdges, ...rest } = value as Record<string, unknown>;
    if (roughEdges === undefined || roughEdges === null) {
      notes.push("Reviewer returned no rough edge list; treated it as empty.");
      return { ...rest, roughEdges: [] };
    }
    if (!Array.isArray(roughEdges)) return value;
    const valid = roughEdges.filter((edge) => RoughEdge.safeParse(edge).success);
    const dropped = roughEdges.length - valid.length;
    if (dropped > 0) notes.push(`Dropped ${dropped} invalid rough edge(s) from the reviewer.`);
    return { ...rest, roughEdges: valid };
  }, ReviewOutput);
  return { schema, notes: () => notes };
}

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

export const RoughEdgeCheck = z.strictObject({
  status: z.enum(["accurate", "inaccurate", "unclear"]),
  /** One line: what the checker found in the code. */
  note: z.string(),
  /** The final priority: the reviewer's, kept or changed. */
  priority: Priority,
});
export type RoughEdgeCheck = z.infer<typeof RoughEdgeCheck>;

/** The checker's answer: one check per rough edge, matched by `localId`. */
export const RoughEdgeChecks = z.strictObject({
  checks: z.array(RoughEdgeCheck.extend({ localId: z.string() })),
});
export type RoughEdgeChecks = z.infer<typeof RoughEdgeChecks>;

/** A rough edge after normalization: stable run-wide id (`R-001`…) assigned. */
export type NormalizedRoughEdge = RoughEdge & { id: string };

/** A normalized rough edge with its check; the record in rough-edges.json. */
export type CheckedRoughEdge = NormalizedRoughEdge & { check: RoughEdgeCheck };

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

/** An `ask` answer: short Markdown, with a `file:line` reference for each claim about the code. */
export const Answer = z.strictObject({
  answer: z.string(),
});
export type Answer = z.infer<typeof Answer>;
