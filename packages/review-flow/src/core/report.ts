import { describeModel, formatCost, formatDuration, formatLocation } from "./format.ts";
import type { Harness, RoleModels } from "./models.ts";
import { codeFence } from "./prompts.ts";
import { rankFindings, type RankedItem } from "./rank.ts";
import type { Evidence, NormalizedFinding, Verdict } from "./schemas.ts";
import { truncateFix } from "./verify.ts";

export interface ReportInput {
  harness: Harness;
  models: RoleModels;
  base: { ref: string; sha: string };
  head: { sha: string; snapshotSha?: string };
  durationMs: number;
  /** null when the harness reported no cost (Cursor). */
  costUsd: number | null;
  findings: readonly NormalizedFinding[];
  /** findingId → verdict; every finding must have one. */
  verdicts: Readonly<Record<string, Verdict>>;
}

const shortSha = (sha: string) => sha.slice(0, 7);

const oneLine = (text: string) => text.trim().replaceAll(/\s*\n\s*/g, " ");

const CODE_OR_LT = /(`+)[\s\S]*?\1|</g;
const CODE_OR_LT_OR_STAR = /(`+)[\s\S]*?\1|[<*]/g;

/**
 * Escapes `<` (and `*` with `CODE_OR_LT_OR_STAR`) outside code spans and fences, so agent text
 * can't open or close HTML (e.g. a stray `</details>` ending the refuted section early) or end a
 * bold run. Code is left alone: it is already literal.
 */
function escapeHtml(text: string, pattern = CODE_OR_LT): string {
  return text.replaceAll(pattern, (match) =>
    match === "<" ? "&lt;" : match === "*" ? "\\*" : match,
  );
}

/** Agent text placed on a single Markdown line, where a newline would end the line early. */
const inline = (text: string) => escapeHtml(oneLine(text));

/** Table cells are single-line and `|` would end the cell. */
function cell(text: string): string {
  return oneLine(text).replaceAll("|", "\\|");
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * A labelled field. Single-line text goes inline after the label; multi-line text goes in its own
 * block. With `fence` (for fixes, which may be code snippets) that block is fenced unless it already
 * carries its own fences; without it (prose) it stays plain Markdown so it renders and wraps.
 */
function field(
  label: string,
  text: string,
  { note = null, fence = true }: { note?: string | null; fence?: boolean } = {},
): string {
  const trimmed = text.trim();
  const tail = note === null ? "" : ` — ${note}`;
  if (!trimmed.includes("\n")) return `**${label}:** ${escapeHtml(trimmed)}${tail}`;
  const block = !fence || trimmed.includes("```") ? escapeHtml(trimmed) : codeFence(trimmed);
  return `**${label}:**\n\n${block}${note === null ? "" : `\n\n${tail.trimStart()}`}`;
}

function evidenceLine({ kind, file, line, detail }: Evidence): string {
  if (kind === "code_ref" && file !== null) {
    return `- \`${oneLine(line === null ? file : `${file}:${line}`)}\` — ${inline(detail)}`;
  }
  return `- ${inline(detail)}`;
}

function heading({ finding, verdict }: RankedItem): string {
  return (
    `### [ ] ${finding.id} · ${verdict.severity} · ${verdict.verdict} (${verdict.confidence})` +
    ` · \`${formatLocation(finding)}\``
  );
}

function fixFields({ finding, verdict }: RankedItem): string[] {
  const { assessment, detail, betterFix } = verdict.fix;
  const judged =
    assessment === "not_applicable" ? null : `verifier: **${assessment}** (${inline(detail)})`;
  const out: string[] = [];
  if (finding.suggestedFix === null) {
    out.push(field("Suggested fix", "none", { note: judged }));
  } else {
    // The verifier judged the capped version; show the full one, but say what it didn't see.
    const label = truncateFix(finding.suggestedFix).truncated
      ? "Suggested fix (truncated for the verifier)"
      : "Suggested fix";
    out.push(field(label, finding.suggestedFix, { note: judged }));
  }
  if (betterFix !== null) out.push(field("Better fix", betterFix));
  return out;
}

function renderItem(item: RankedItem): string {
  const { finding, verdict } = item;
  const parts = [
    heading(item),
    `**${escapeHtml(oneLine(finding.title), CODE_OR_LT_OR_STAR)}**`,
    field("Claim", finding.claim, { fence: false }),
    field("Verifier", verdict.summary, { fence: false }),
    verdict.evidence.length === 0
      ? "**Evidence:** none"
      : `**Evidence:**\n\n${verdict.evidence.map(evidenceLine).join("\n")}`,
  ];
  // A refuted claim has nothing to fix.
  if (verdict.verdict !== "refuted") parts.push(...fixFields(item));
  parts.push(
    `${finding.category} · reviewer severity: ${finding.severity} → verifier: ${verdict.severity}` +
      ` · fix cost: ${verdict.fixCost}`,
  );
  return parts.join("\n\n");
}

function header(input: ReportInput): string {
  const stats = [`**Duration:** ${formatDuration(input.durationMs)}`];
  if (input.costUsd !== null) stats.push(`**Cost:** ${formatCost(input.costUsd)}`);
  return [
    `# Review: ${input.base.ref}...HEAD`,
    [
      `- **Harness:** ${input.harness}`,
      `- **Reviewer:** ${describeModel(input.models.reviewer)}`,
      `- **Verifier:** ${describeModel(input.models.verifier)}`,
      `- **Base:** \`${input.base.ref}\` (\`${shortSha(input.base.sha)}\`) · **Head:** \`${shortSha(input.head.sha)}\`${input.head.snapshotSha === undefined ? "" : " plus uncommitted changes"}`,
      `- ${stats.join(" · ")}`,
    ].join("\n"),
  ].join("\n\n");
}

function summaryTable(items: readonly RankedItem[]): string {
  const counts = (["confirmed", "inconclusive", "refuted"] as const)
    .map((kind) => [kind, items.filter((i) => i.verdict.verdict === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(" · ");
  const rows = items.map(
    ({ finding, verdict }) =>
      `| ${finding.id} | ${verdict.verdict} (${verdict.confidence}) | ${verdict.severity} | ` +
      `${verdict.fixCost} | \`${cell(formatLocation(finding))}\` | ${cell(escapeHtml(finding.title))} |`,
  );
  return [
    `**${plural(items.length, "finding")}:** ${counts}`,
    [
      "| ID | Verdict | Severity | Fix cost | Location | Title |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n"),
  ].join("\n\n");
}

/** Renders report.md: header, summary table, then ranked findings; refuted ones collapsed. */
export function renderReport(input: ReportInput): string {
  const items = rankFindings(
    input.findings.map((finding) => {
      const verdict = input.verdicts[finding.id];
      if (verdict === undefined) throw new Error(`No verdict for ${finding.id}`);
      return { finding, verdict };
    }),
  );

  const sections = [header(input)];
  if (items.length === 0) {
    sections.push("No findings.");
    return `${sections.join("\n\n")}\n`;
  }

  sections.push(summaryTable(items), "Tick `[x]` on the findings you want fixed.");
  for (const kind of ["confirmed", "inconclusive"] as const) {
    const group = items.filter((i) => i.verdict.verdict === kind);
    if (group.length === 0) continue;
    sections.push(`## ${kind[0]!.toUpperCase()}${kind.slice(1)} (${group.length})`);
    sections.push(...group.map(renderItem));
  }

  const refuted = items.filter((i) => i.verdict.verdict === "refuted");
  if (refuted.length > 0) {
    // Blank lines inside <details> so its content is still parsed as Markdown.
    sections.push(
      [
        "<details>",
        `<summary>Refuted (${refuted.length})</summary>`,
        refuted.map(renderItem).join("\n\n"),
        "</details>",
      ].join("\n\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}
