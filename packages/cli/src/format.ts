import { styleText } from "node:util";
import type { NormalizedFinding, Severity } from "@review-flow/core";

type Style = Parameters<typeof styleText>[0];

export interface FormatOptions {
  color: boolean;
  /** Total line width to wrap text to. */
  width: number;
}

export interface FindingsSummary {
  findings: NormalizedFinding[];
  base: string;
  runDir: string;
  costUsd: number;
  durationMs: number;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

const SEVERITY_STYLE: Record<Severity, Style> = {
  critical: ["bold", "white", "bgRed"],
  high: ["bold", "red"],
  medium: ["bold", "yellow"],
  low: ["bold", "blue"],
};

const LABEL_WIDTH = 7;
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

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function location(finding: NormalizedFinding): string {
  const lines =
    finding.lineStart === finding.lineEnd
      ? `${finding.lineStart}`
      : `${finding.lineStart}-${finding.lineEnd}`;
  return `${finding.file}:${lines}`;
}

export function formatFindings(summary: FindingsSummary, options: FormatOptions): string {
  const paint = (style: Style, text: string) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;

  const findings = summary.findings.toSorted(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const counts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: findings.filter((f) => f.severity === severity).length,
  })).filter(({ count }) => count > 0);
  const breakdown = counts
    .map(({ severity, count }) => paint(SEVERITY_STYLE[severity], `${count} ${severity}`))
    .join(paint("dim", " · "));

  const out: string[] = [""];
  const stats = paint(
    "dim",
    `${summary.base}...HEAD · ${formatDuration(summary.durationMs)} · $${summary.costUsd.toFixed(2)}`,
  );

  if (findings.length === 0) {
    out.push(`${paint(["bold", "green"], "No findings")}  ${stats}`, "");
  } else {
    const title = paint("bold", `${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    out.push(`${title}  ${breakdown}  ${stats}`);
    out.push(paint("dim", "Unverified: the reviewer's claims have not been checked yet."), "");
  }

  const textWidth = Math.max(40, options.width - INDENT.length - LABEL_WIDTH);
  const field = (label: string, text: string) => {
    wrap(text, textWidth).forEach((line, index) => {
      const prefix =
        index === 0 ? paint("dim", label.padEnd(LABEL_WIDTH)) : " ".repeat(LABEL_WIDTH);
      out.push(`${INDENT}${prefix}${line}`);
    });
  };

  for (const finding of findings) {
    const severity = paint(SEVERITY_STYLE[finding.severity], ` ${finding.severity.toUpperCase()} `);
    out.push(
      `${paint("bold", finding.id)} ${severity} ${paint("dim", finding.category)}  ${paint("bold", finding.title)}`,
    );
    out.push(`${INDENT}${paint("cyan", location(finding))}`);
    field("Claim", finding.claim);
    if (finding.suggestedFix !== null) field("Fix", finding.suggestedFix);
    out.push("");
  }

  out.push(paint("dim", `Details: ${summary.runDir}`), "");
  return out.join("\n");
}
