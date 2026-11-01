import { styleText } from "node:util";
import {
  formatCost,
  formatDuration,
  formatLocation,
  matchFindings,
  rankFindings,
  compareSteps,
  type IndexEntry,
  type LoadedRun,
  type ModelChoice,
  type NormalizedFinding,
  type TimedTotals,
  type Verdict,
} from "@review-flow/core";

type Style = Parameters<typeof styleText>[0];

export interface TableOptions {
  color: boolean;
}

/** Pads cells to column width; columns listed in `right` are right-aligned. */
function table(rows: string[][], right: ReadonlySet<number> = new Set()): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  return rows.map((row) =>
    row
      .map((cell, i) =>
        right.has(i) ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

/** `model effort`, or just the model. */
export function shortModel({ model, effort }: ModelChoice): string {
  const name = model ?? "default";
  return effort === null ? name : `${name} ${effort}`;
}

function describeModels(models: { reviewer: ModelChoice; verifier: ModelChoice }): string {
  const reviewer = shortModel(models.reviewer);
  const verifier = shortModel(models.verifier);
  return reviewer === verifier ? reviewer : `${reviewer} / ${verifier}`;
}

/** `-` without calls, `?` when no call has a cost, `≥$x` when some calls have none. */
function costCell(costUsd: number | null, unknownCostCalls: number): string {
  if (costUsd === null) return unknownCostCalls > 0 ? "?" : "-";
  return `${unknownCostCalls > 0 ? "≥" : ""}${formatCost(costUsd)}`;
}

function findingsCell(entry: IndexEntry): string {
  if (entry.findings === null) return "-";
  if (entry.verdicts === null) return String(entry.findings);
  return `${entry.findings} (${entry.verdicts.confirmed} confirmed)`;
}

/** Newest first. */
export function formatRuns(entries: readonly IndexEntry[], options: TableOptions): string {
  if (entries.length === 0) return "No runs yet.";
  const paint = (style: Style, text: string) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;

  const rows = [
    ["Run", "Status", "Harness", "Models", "Diff", "Findings", "Cost", "Time"],
    ...entries
      .toReversed()
      .map((e) => [
        e.id,
        e.status,
        e.harness,
        describeModels(e.models),
        `${e.diff.files} files +${e.diff.additions} -${e.diff.deletions}`,
        findingsCell(e),
        costCell(e.costUsd, e.unknownCostCalls),
        formatDuration(e.durationMs),
      ]),
  ];
  const [header = "", ...lines] = table(rows, new Set([6, 7]));
  return [
    paint("dim", header),
    ...lines.map((line, i) =>
      entries.at(-1 - i)?.status === "failed" ? paint("red", line) : line,
    ),
  ].join("\n");
}

/** `+x` or `-x`; unsigned when it rounds to zero. */
function signed(value: number, format: (abs: number) => string): string {
  const text = format(Math.abs(value));
  return text === format(0) ? text : `${value < 0 ? "-" : "+"}${text}`;
}

function costDelta(a: TimedTotals | null, b: TimedTotals | null): string {
  if (a === null || b === null) return "-";
  if (a.unknownCostCalls > 0 || b.unknownCostCalls > 0) return "?";
  if (a.costUsd === null && b.costUsd === null) return "-";
  return signed((b.costUsd ?? 0) - (a.costUsd ?? 0), formatCost);
}

interface Item {
  finding: NormalizedFinding;
  verdict: Verdict | null;
}

/** Ranked as in the report; findings without a verdict go last. */
function rank(findings: readonly NormalizedFinding[], verdicts: LoadedRun["verdicts"]): Item[] {
  const items = findings.map((finding) => ({ finding, verdict: verdicts?.[finding.id] ?? null }));
  const verified = items.filter(
    (i): i is { finding: NormalizedFinding; verdict: Verdict } => i.verdict !== null,
  );
  return [...rankFindings(verified), ...items.filter((i) => i.verdict === null)];
}

function label({ finding, verdict }: Item): string {
  return verdict === null
    ? `${finding.id} unverified ${finding.severity}`
    : `${finding.id} ${verdict.verdict} ${verdict.severity}`;
}

/** `sha..sha`, led by the base ref unless the ref is itself a SHA. */
function diffOf({ run }: LoadedRun): string {
  const range = `${run.base.sha.slice(0, 7)}..${run.head.sha.slice(0, 7)}`;
  return run.base.sha.startsWith(run.base.ref) ? range : `${run.base.ref} ${range}`;
}

function itemOf(items: readonly Item[], finding: NormalizedFinding): Item {
  return items.find((i) => i.finding === finding) as Item;
}

export function formatCompare(a: LoadedRun, b: LoadedRun, options: TableOptions): string {
  const paint = (style: Style, text: string) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;
  const out: string[] = [];

  const info = table([
    ["", "A", "B"],
    ["Run", a.id, b.id],
    ["Harness", a.run.harness, b.run.harness],
    ["Reviewer", shortModel(a.run.models.reviewer), shortModel(b.run.models.reviewer)],
    ["Verifier", shortModel(a.run.models.verifier), shortModel(b.run.models.verifier)],
    ["Diff", diffOf(a), diffOf(b)],
    ["Status", a.run.status, b.run.status],
  ]);
  out.push(...info, "");

  const steps = table(
    [
      ["Step", "Cost A", "Cost B", "Δ cost", "Time A", "Time B", "Δ time", "Calls"],
      ...compareSteps(a.run, b.run).map(({ step, a: sa, b: sb }) => [
        step,
        sa === null ? "-" : costCell(sa.costUsd, sa.unknownCostCalls),
        sb === null ? "-" : costCell(sb.costUsd, sb.unknownCostCalls),
        costDelta(sa, sb),
        sa === null ? "-" : formatDuration(sa.durationMs),
        sb === null ? "-" : formatDuration(sb.durationMs),
        sa === null || sb === null ? "-" : signed(sb.durationMs - sa.durationMs, formatDuration),
        `${sa?.calls ?? "-"} / ${sb?.calls ?? "-"}`,
      ]),
    ],
    new Set([1, 2, 3, 4, 5, 6]),
  );
  const [stepHeader = "", ...stepLines] = steps;
  out.push(paint("dim", stepHeader), ...stepLines, "");

  if (a.findings === null || b.findings === null) {
    out.push("Findings: not compared; a run failed before the reviewer returned.");
    return out.join("\n");
  }
  if (a.run.base.sha !== b.run.base.sha || a.run.head.sha !== b.run.head.sha) {
    out.push(
      paint(
        "yellow",
        "The runs reviewed different commits, so matching findings by line is rough.",
      ),
      "",
    );
  }

  const match = matchFindings(a.findings, b.findings);
  out.push(
    paint(
      "bold",
      `Findings: ${a.findings.length} in A, ${b.findings.length} in B, ${match.both.length} in both`,
    ),
  );
  const itemsA = rank(a.findings, a.verdicts);
  const itemsB = rank(b.findings, b.verdicts);
  const pairOf = new Map(match.both.map(([fa, fb]) => [fa, fb]));

  const both = itemsA.flatMap((ia) => {
    const fb = pairOf.get(ia.finding);
    return fb === undefined ? [] : [[ia, itemOf(itemsB, fb)] as const];
  });
  if (both.length > 0) {
    out.push("", paint("dim", "In both (A → B)"));
    for (const line of table(
      both.map(([ia, ib]) => [
        label(ia),
        "→",
        label(ib),
        formatLocation(ia.finding),
        ia.finding.title,
      ]),
    )) {
      out.push(`  ${line}`);
    }
  }
  for (const [title, items, only] of [
    ["Only in A", itemsA, match.onlyA],
    ["Only in B", itemsB, match.onlyB],
  ] as const) {
    if (only.length === 0) continue;
    out.push("", paint("dim", title));
    const rows = items
      .filter((i) => only.includes(i.finding))
      .map((i) => [label(i), formatLocation(i.finding), i.finding.title]);
    for (const line of table(rows)) out.push(`  ${line}`);
  }
  return out.join("\n");
}
