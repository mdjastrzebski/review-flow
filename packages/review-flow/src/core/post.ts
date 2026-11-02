import { formatLocation } from "./format.ts";
import { codeFence } from "./prompts.ts";
import { rankFindings, type RankedItem } from "./rank.ts";
import { renderSummary } from "./report.ts";
import type { NormalizedFinding, Severity, Summary, Verdict } from "./schemas.ts";

export const REVIEW_FLOW_URL = "https://github.com/mdjastrzebski/review-flow";

export interface PostableItem extends RankedItem {
  /** Confirmed findings of medium severity or higher start selected. */
  preselected: boolean;
}

const PRESELECTED_SEVERITIES: ReadonlySet<Severity> = new Set(["critical", "high", "medium"]);

/** Findings that may be posted (all but refuted), ranked. */
export function postableItems(
  findings: readonly NormalizedFinding[],
  verdicts: Readonly<Record<string, Verdict>>,
): PostableItem[] {
  const items = findings.flatMap((finding) => {
    const verdict = verdicts[finding.id];
    return verdict === undefined || verdict.verdict === "refuted" ? [] : [{ finding, verdict }];
  });
  return rankFindings(items).map((item) => ({
    ...item,
    preselected:
      item.verdict.verdict === "confirmed" && PRESELECTED_SEVERITIES.has(item.verdict.severity),
  }));
}

/** File → lines of the new version that appear in the diff (added or context), which GitHub can comment on. */
export function diffLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      lines = null;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      lines = null;
      if (target.startsWith("b/")) {
        lines = new Set();
        files.set(target.slice(2), lines);
      }
    } else if (line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      next = match === null ? 0 : Number(match[1]);
    } else if (lines !== null && next > 0 && (line.startsWith("+") || line.startsWith(" "))) {
      lines.add(next++);
    }
  }
  return files;
}

export interface Anchor {
  line: number;
  /** Set for a multi-line comment. */
  startLine: number | null;
}

/**
 * Where an inline comment goes: the whole range when every line of it is in the diff, else the
 * first line of the range that is. null when no line is, so the finding goes in the review body.
 */
export function anchorFinding(
  finding: NormalizedFinding,
  lines: ReadonlyMap<string, ReadonlySet<number>>,
): Anchor | null {
  const inDiff = lines.get(finding.file);
  if (inDiff === undefined) return null;
  const range = Array.from(
    { length: finding.lineEnd - finding.lineStart + 1 },
    (_, i) => finding.lineStart + i,
  );
  const covered = range.filter((line) => inDiff.has(line));
  if (covered.length === 0) return null;
  if (covered.length === range.length && range.length > 1) {
    return { line: finding.lineEnd, startLine: finding.lineStart };
  }
  return { line: covered[0] as number, startLine: null };
}

/** The fix to post: the verifier's better fix when it found the suggested one lacking. */
function fixToPost({ finding, verdict }: RankedItem): string | null {
  const { assessment, betterFix } = verdict.fix;
  if ((assessment === "flawed" || assessment === "incomplete") && betterFix !== null) {
    return betterFix;
  }
  if (assessment === "flawed") return null;
  return finding.suggestedFix ?? betterFix;
}

export function commentBody(item: RankedItem): string {
  const parts = [
    `**${item.finding.title.trim()}** (${item.verdict.severity})`,
    item.finding.claim.trim(),
  ];
  const fix = fixToPost(item)?.trim();
  if (fix !== undefined && fix !== "") {
    parts.push(
      fix.includes("\n") && !fix.includes("```")
        ? `**Suggested fix:**\n\n${codeFence(fix)}`
        : `**Suggested fix:** ${fix}`,
    );
  }
  return parts.join("\n\n");
}

/** A comment of the GitHub "create a review" API. */
export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

/** The body of `POST /repos/{owner}/{repo}/pulls/{number}/reviews`. */
export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
}

export interface ReviewPlan {
  payload: ReviewPayload;
  /** Finding id of each entry of `payload.comments`, in order. */
  inline: string[];
  /** Ids of findings placed in the review body. */
  inBody: string[];
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * One review with event COMMENT (never approve or request changes): findings on diff lines become
 * inline comments, the rest go in the body with the run's summary (when it has one), the finding
 * counts, and a footer.
 */
export function buildReview(
  items: readonly RankedItem[],
  diff: string,
  commitId: string,
  summary: Summary | null = null,
): ReviewPlan {
  const lines = diffLines(diff);
  const comments: ReviewComment[] = [];
  const inline: string[] = [];
  const inBody: RankedItem[] = [];
  for (const item of items) {
    const anchor = anchorFinding(item.finding, lines);
    if (anchor === null) {
      inBody.push(item);
      continue;
    }
    comments.push({
      path: item.finding.file,
      line: anchor.line,
      side: "RIGHT",
      ...(anchor.startLine === null ? {} : { start_line: anchor.startLine, start_side: "RIGHT" }),
      body: commentBody(item),
    });
    inline.push(item.finding.id);
  }

  const counts = [`${plural(items.length, "finding")}`];
  if (comments.length > 0) counts.push(`${comments.length} inline`);
  if (inBody.length > 0) counts.push(`${inBody.length} outside the diff, below`);
  const sections = summary === null ? [] : [renderSummary(summary)];
  sections.push(counts.join(" · "));
  for (const item of inBody) {
    sections.push(`\`${formatLocation(item.finding)}\`\n\n${commentBody(item)}`);
  }
  sections.push(`<sub>Reviewed with [review-flow](${REVIEW_FLOW_URL}).</sub>`);

  return {
    payload: {
      commit_id: commitId,
      event: "COMMENT",
      body: sections.join("\n\n---\n\n"),
      comments,
    },
    inline,
    inBody: inBody.map((item) => item.finding.id),
  };
}

/** posted.json: what was posted, for repeat suppression and response tracking later. */
export interface PostedRecord {
  postedAt: string;
  reviewId: number;
  url: string;
  commitId: string;
  findings: { id: string; commentId: number | null }[];
}
