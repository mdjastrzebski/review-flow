import { formatLocation } from "./format.ts";
import { codeFence } from "./prompts.ts";
import { rankFindings, type RankedItem } from "./rank.ts";
import { renderSummary } from "./report.ts";
import { keptRoughEdges } from "./rough-edges.ts";
import type { CheckedRoughEdge, NormalizedFinding, Severity, Summary, Verdict } from "./schemas.ts";
import type { TrustLevel } from "./trust.ts";

export const REVIEW_FLOW_URL = "https://github.com/mdjastrzebski/review-flow";

/** Anything the user can pick to post: a finding or a rough edge, ready to place and render. */
export interface PostableItem {
  /** Finding id (`F-001`) or rough edge id (`R-001`). */
  id: string;
  kind: "finding" | "rough-edge";
  location: Pick<NormalizedFinding, "file" | "lineStart" | "lineEnd">;
  title: string;
  /** Short classification shown after the id in the selection list, such as `high confirmed`. */
  tag: string;
  /** Extra note for the selection list. */
  hint: string | null;
  /** Markdown of the comment as posted. */
  body: string;
  /** Confirmed findings of medium severity or higher start selected; rough edges never do. */
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
    id: item.finding.id,
    kind: "finding",
    location: item.finding,
    title: item.finding.title,
    tag: `${item.verdict.severity} ${item.verdict.verdict}`,
    hint: null,
    body: commentBody(item),
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
  finding: Pick<NormalizedFinding, "file" | "lineStart" | "lineEnd">,
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

function suggestionField(label: string, text: string): string {
  return text.includes("\n") && !text.includes("```")
    ? `**${label}:**\n\n${codeFence(text)}`
    : `**${label}:** ${text}`;
}

export function commentBody(item: RankedItem): string {
  const parts = [
    `**${item.finding.title.trim()}** (${item.verdict.severity})`,
    item.finding.claim.trim(),
  ];
  const fix = fixToPost(item)?.trim();
  if (fix !== undefined && fix !== "") parts.push(suggestionField("Suggested fix", fix));
  return parts.join("\n\n");
}

/** Rough edges that may be posted: all the checker did not rule out. Never pre-selected. */
export function postableRoughEdges(edges: readonly CheckedRoughEdge[]): PostableItem[] {
  return keptRoughEdges(edges).map((edge) => ({
    id: edge.id,
    kind: "rough-edge",
    location: edge,
    title: edge.title,
    tag: `${edge.lens} rough edge`,
    hint: "not a defect",
    body: roughEdgeBody(edge),
    preselected: false,
  }));
}

/** Labelled, so a reader can tell it from a finding: it is not a defect. */
export function roughEdgeBody(edge: CheckedRoughEdge): string {
  return [
    `**Rough edge (${edge.lens}): ${edge.title.trim()}**`,
    edge.observation.trim(),
    suggestionField("Suggestion", edge.suggestion.trim()),
  ].join("\n\n");
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
  /** Id of each entry of `payload.comments`, in order. */
  inline: string[];
  /** Ids of items placed in the review body. */
  inBody: string[];
}

/** Items on diff lines become inline comments; the rest are left for the review body. */
function placeItems(
  items: readonly PostableItem[],
  lines: ReadonlyMap<string, ReadonlySet<number>>,
): { comments: ReviewComment[]; inline: string[]; inBody: PostableItem[] } {
  const comments: ReviewComment[] = [];
  const inline: string[] = [];
  const inBody: PostableItem[] = [];
  for (const item of items) {
    const anchor = anchorFinding(item.location, lines);
    if (anchor === null) {
      inBody.push(item);
      continue;
    }
    comments.push({
      path: item.location.file,
      line: anchor.line,
      side: "RIGHT",
      ...(anchor.startLine === null ? {} : { start_line: anchor.startLine, start_side: "RIGHT" }),
      body: item.body,
    });
    inline.push(item.id);
  }
  return { comments, inline, inBody };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export interface BuildReviewOptions {
  /** The run's summary, put at the top of the body. */
  summary?: Summary | null;
  /** Trust level shown with the summary. */
  trust?: TrustLevel;
}

/**
 * One review with event COMMENT (never approve or request changes): items on diff lines become
 * inline comments, the rest go in the body with the run's summary (when it has one), the counts,
 * and a footer.
 */
export function buildReview(
  items: readonly PostableItem[],
  diff: string,
  commitId: string,
  { summary = null, trust = "collaborator" }: BuildReviewOptions = {},
): ReviewPlan {
  const { comments, inline, inBody } = placeItems(items, diffLines(diff));

  const roughEdgeCount = items.filter((item) => item.kind === "rough-edge").length;
  const counts = [plural(items.length - roughEdgeCount, "finding")];
  if (roughEdgeCount > 0) counts.push(plural(roughEdgeCount, "rough edge"));
  if (comments.length > 0) counts.push(`${comments.length} inline`);
  if (inBody.length > 0) counts.push(`${inBody.length} outside the diff, below`);
  const sections = summary === null ? [] : [renderSummary(summary, trust)];
  sections.push(counts.join(" · "));
  for (const item of inBody) {
    sections.push(`\`${formatLocation(item.location)}\`\n\n${item.body}`);
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
    inBody: inBody.map((item) => item.id),
  };
}

/** posted.json: what was posted, for repeat suppression and response tracking later. */
export interface PostedRecord {
  postedAt: string;
  reviewId: number;
  url: string;
  commitId: string;
  /** Findings and rough edges, by id. */
  items: { id: string; commentId: number | null }[];
}
