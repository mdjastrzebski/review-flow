import { normalizeFile } from "./normalize.ts";
import { codeFence, renderPrompt } from "./prompts.ts";
import type { CodeRef, Summary } from "./schemas.ts";
import type { TrustLevel } from "./trust.ts";
import type { ChangeRange } from "./verify.ts";

export const MAX_CHANGES = 6;
export const MAX_LOOK_AT = 3;
/** Caps the author's description, so a long PR body or history can't dominate the prompt. */
export const MAX_INTENT_CHARS = 8000;

/** What the summary got, or why there is none. A skipped summary (`--no-summary`) is null. */
export type SummaryOutcome =
  | { status: "ok"; summary: Summary }
  | { status: "failed"; error: string };

/** Where the stated goal comes from: the PR, or the commits on the branch. */
export type Intent =
  | { kind: "pr"; number: number; title: string; body: string }
  | { kind: "commits"; messages: string[]; uncommitted: boolean };

function capped(text: string): string {
  return text.length <= MAX_INTENT_CHARS
    ? text
    : `${text.slice(0, MAX_INTENT_CHARS).trimEnd()}… [truncated]`;
}

/** The author's description as prompt text: always fenced, since it is untrusted. */
export function describeIntent(intent: Intent): string {
  if (intent.kind === "pr") {
    const text = `${intent.title.trim()}\n\n${intent.body.trim()}`.trim();
    return `Title and description of PR #${intent.number}:\n\n${codeFence(capped(text))}`;
  }
  const parts: string[] = [];
  if (intent.messages.length === 0) {
    parts.push("The change has no commits of its own, so there are no commit messages.");
  } else {
    parts.push(
      `Commit messages, oldest first:\n\n${codeFence(capped(intent.messages.join("\n\n---\n\n")))}`,
    );
  }
  if (intent.uncommitted)
    parts.push("The change also includes uncommitted changes, which have no message.");
  return parts.join("\n\n");
}

export function buildSummarizerPrompt(
  template: string,
  change: ChangeRange,
  intent: Intent,
): string {
  return renderPrompt(template, { ...change, intent: describeIntent(intent) });
}

/** Caps the lists the prompt bounds, and makes paths repo-relative. */
export function normalizeSummary(summary: Summary, repo: string): Summary {
  const ref = (item: CodeRef): CodeRef => ({ ...item, file: normalizeFile(item.file, repo) });
  return {
    goal: summary.goal,
    changes: summary.changes.slice(0, MAX_CHANGES),
    achieved: {
      verdict: summary.achieved.verdict,
      gaps: summary.achieved.gaps.map(ref),
      extras: summary.achieved.extras.map(ref),
    },
    lookAt: summary.lookAt.slice(0, MAX_LOOK_AT).map(ref),
  };
}

/** The note after the goal: `inferred`, or for an `external` target, whose author is unknown, `as stated by the author`. */
export function goalNote(goal: Summary["goal"], trust: TrustLevel): string | null {
  if (goal.source === "inferred") return "inferred";
  return trust === "external" ? "as stated by the author" : null;
}

/** `file:line`, or `file` when no line fits. */
export function formatCodeRef({ file, line }: CodeRef): string {
  return line === null ? file : `${file}:${line}`;
}
