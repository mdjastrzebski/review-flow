import { styleText } from "node:util";
import {
  formatCodeRef,
  formatCost,
  formatDuration,
  formatLocation,
  rankFindings,
  type FixAssessment,
  type NormalizedFinding,
  type Severity,
  type Summary,
  type SummaryOutcome,
  type Verdict,
} from "../core/index.ts";

type Style = Parameters<typeof styleText>[0];

export interface FormatOptions {
  color: boolean;
  /** Total line width to wrap text to. */
  width: number;
}

export interface FindingsSummary {
  findings: NormalizedFinding[];
  verdicts: Record<string, Verdict>;
  base: string;
  reportPath: string;
  costUsd: number | null;
  durationMs: number;
}

const SEVERITY_STYLE: Record<Severity, Style> = {
  critical: ["bold", "white", "bgRed"],
  high: ["bold", "red"],
  medium: ["bold", "yellow"],
  low: ["bold", "blue"],
};

const VERDICT_STYLE: Record<Verdict["verdict"], Style> = {
  confirmed: ["bold", "red"],
  inconclusive: ["bold", "yellow"],
  refuted: ["dim"],
};

const FIX_LABEL: Record<FixAssessment["assessment"], string> = {
  sound: "sound",
  flawed: "flawed",
  incomplete: "incomplete",
  not_applicable: "n/a",
};

const LABEL_WIDTH = 10;
const INDENT = "  ";

/** Greedy word wrap; words longer than the width are kept whole rather than split. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The summary, printed before the findings. */
export function formatSummary(outcome: SummaryOutcome, options: FormatOptions): string {
  const paint = (style: Style, text: string) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;
  const header = ["", paint("bold", "Summary")];
  if (outcome.status === "failed") {
    header.push(paint("yellow", `${INDENT}Missing: the summarizer failed (${outcome.error}).`));
    return header.join("\n");
  }
  const body = formatSummaryFields(outcome.summary, {
    ...options,
    width: options.width - INDENT.length,
  });
  return [...header, ...body.split("\n").map((line) => `${INDENT}${line}`)].join("\n");
}

/** The summary's fields as labelled, wrapped lines, without a heading or indent. */
export function formatSummaryFields(summary: Summary, options: FormatOptions): string {
  const paint = (style: Style, text: string) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;
  const out: string[] = [];
  const { goal, changes, achieved, lookAt } = summary;
  const textWidth = Math.max(40, options.width - LABEL_WIDTH);
  const field = (label: string, text: string) => {
    wrap(text, textWidth).forEach((line, index) => {
      const prefix =
        index === 0 ? paint("dim", label.padEnd(LABEL_WIDTH)) : " ".repeat(LABEL_WIDTH);
      out.push(`${prefix}${line}`);
    });
  };
  const bullets = (label: string, items: string[]) => {
    items.forEach((item, index) => {
      const lines = wrap(item, textWidth - 2);
      lines.forEach((line, at) => {
        const prefix =
          index === 0 && at === 0
            ? paint("dim", label.padEnd(LABEL_WIDTH))
            : " ".repeat(LABEL_WIDTH);
        out.push(`${prefix}${at === 0 ? "- " : "  "}${line}`);
      });
    });
  };
  const ref = (item: Parameters<typeof formatCodeRef>[0]) =>
    `${paint("cyan", formatCodeRef(item))} ${item.detail}`;

  field("Goal", goal.source === "inferred" ? `${goal.text} (inferred)` : goal.text);
  bullets("Changes", changes);
  field("Goal met", achieved.verdict);
  bullets("Gaps", achieved.gaps.map(ref));
  bullets("Extras", achieved.extras.map(ref));
  bullets("Look at", lookAt.map(ref));
  return out.join("\n");
}

export function formatFindings(summary: FindingsSummary, options: FormatOptions): string {
  const paint = (style: Style, text: string) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;

  const items = rankFindings(
    summary.findings.flatMap((finding) => {
      const verdict = summary.verdicts[finding.id];
      return verdict === undefined ? [] : [{ finding, verdict }];
    }),
  );
  const findings = items.map((item) => item.finding);

  const breakdown = (["confirmed", "inconclusive", "refuted"] as const)
    .map((kind) => ({ kind, count: items.filter((i) => i.verdict.verdict === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => paint(VERDICT_STYLE[kind], `${count} ${kind}`))
    .join(paint("dim", " · "));

  const out: string[] = [""];
  const stats = paint(
    "dim",
    [
      `${summary.base}...HEAD`,
      formatDuration(summary.durationMs),
      ...(summary.costUsd === null ? [] : [formatCost(summary.costUsd)]),
    ].join(" · "),
  );

  if (findings.length === 0) {
    out.push(`${paint(["bold", "green"], "No findings")}  ${stats}`, "");
  } else {
    const title = paint("bold", `${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    out.push(`${title}  ${breakdown}  ${stats}`, "");
  }

  const textWidth = Math.max(40, options.width - INDENT.length - LABEL_WIDTH);
  const field = (label: string, text: string) => {
    wrap(text, textWidth).forEach((line, index) => {
      const prefix =
        index === 0 ? paint("dim", label.padEnd(LABEL_WIDTH)) : " ".repeat(LABEL_WIDTH);
      out.push(`${INDENT}${prefix}${line}`);
    });
  };

  for (const { finding, verdict } of items) {
    const severity = paint(SEVERITY_STYLE[verdict.severity], ` ${verdict.severity.toUpperCase()} `);
    const status = paint(VERDICT_STYLE[verdict.verdict], verdict.verdict);
    out.push(
      `${paint("bold", finding.id)} ${severity} ${status} ${paint("dim", `(${verdict.confidence} confidence)`)}  ${paint("bold", finding.title)}`,
    );
    out.push(
      `${INDENT}${paint("cyan", formatLocation(finding))} ${paint("dim", finding.category)}`,
    );
    field("Claim", finding.claim);
    field("Verifier", verdict.summary);
    if (finding.suggestedFix !== null) field("Fix", finding.suggestedFix);
    if (verdict.verdict !== "refuted") {
      field("Fix check", `${FIX_LABEL[verdict.fix.assessment]}: ${verdict.fix.detail}`);
      if (verdict.fix.betterFix !== null) field("Better", verdict.fix.betterFix);
    }
    out.push("");
  }

  out.push(paint("dim", `Report: ${summary.reportPath}`), "");
  return out.join("\n");
}
