import { formatLocation } from "./format.ts";
import { codeFence, renderPrompt } from "./prompts.ts";
import type { NormalizedFinding } from "./schemas.ts";

/** The reviewer is asked for ≤ 3 sentences or a ≤ 10-line snippet; this is the enforced cap. */
export const MAX_FIX_LINES = 10;
export const MAX_FIX_CHARS = 800;

const TRUNCATION_MARK = "… [truncated]";

export interface TruncatedFix {
  text: string;
  truncated: boolean;
}

/** Caps the suggested fix so a long one can't dominate (and anchor) the verifier prompt. */
export function truncateFix(fix: string): TruncatedFix {
  let text = fix.trim();
  const lines = text.split("\n");
  if (lines.length > MAX_FIX_LINES) text = lines.slice(0, MAX_FIX_LINES).join("\n");
  if (text.length > MAX_FIX_CHARS) text = text.slice(0, MAX_FIX_CHARS).trimEnd();
  const truncated = text !== fix.trim();
  return { text: truncated ? `${text}${TRUNCATION_MARK}` : text, truncated };
}

export function verifierTaskId(finding: NormalizedFinding): string {
  return `verifier-${finding.id}`;
}

function fixSection(suggestedFix: string | null): string {
  if (suggestedFix === null) return "No fix was suggested.";
  return `Suggested fix:\n\n${codeFence(truncateFix(suggestedFix).text)}`;
}

/** What the diff spans, as prompt text: `base` is a ref, `head` is already formatted. */
export interface ChangeRange {
  base: string;
  head: string;
}

/** The range under review, for prompts: a PR head, HEAD, or HEAD plus uncommitted changes. */
export function changeRangeOf(
  base: string,
  head: { pr?: { number: number } | undefined; uncommitted: boolean },
): ChangeRange {
  return {
    base,
    head:
      head.pr !== undefined
        ? `\`HEAD\` (the head of PR #${head.pr.number})`
        : head.uncommitted
          ? "`HEAD` plus uncommitted changes"
          : "`HEAD`",
  };
}

/**
 * Builds the verifier prompt from the finding's title, location, claim and (truncated) suggested
 * fix. The reviewer's rationale, severity and category are deliberately left out so they can't
 * anchor the verdict. The diff is not included; it goes in the shared context.
 */
export function buildVerifierPrompt(
  template: string,
  finding: NormalizedFinding,
  change: ChangeRange,
): string {
  return renderPrompt(template, {
    ...change,
    title: finding.title,
    location: formatLocation(finding),
    claim: finding.claim,
    fix: fixSection(finding.suggestedFix),
  });
}

/**
 * The diff, as context shared by all verifiers. It is identical for every finding, so the harness
 * can cache it once per run instead of once per verifier.
 */
export function buildChangeContext(template: string, change: ChangeRange, diff: string): string {
  return renderPrompt(template, { ...change, diffBlock: codeFence(diff, "diff") });
}
