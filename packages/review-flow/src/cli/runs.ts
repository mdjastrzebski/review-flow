import path from "node:path";
import { styleText } from "node:util";
import {
  formatCost,
  formatDuration,
  formatLocation,
  matchFindings,
  rankFindings,
  compareSteps,
  caseOutcome,
  describeModel,
  type CaseResult,
  type RoughEdgeJudgeScores,
  type RoughEdgeScores,
  type EvalRunResult,
  type EvalScores,
  type IndexEntry,
  type LoadedEval,
  type LoadedRun,
  type ModelChoice,
  type NormalizedFinding,
  type PairwiseRecord,
  type TimedTotals,
  type Verdict,
} from "../core/index.ts";

type Style = Parameters<typeof styleText>[0];
type StepTotals = Parameters<typeof compareSteps>[0];

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

/** `-` when the run had no summary, or predates the summarizer. */
function summarizerOf(run: { models: { summarizer?: ModelChoice }; steps: object }): string {
  const { summarizer } = run.models;
  return summarizer === undefined || !("summarize" in run.steps) ? "-" : shortModel(summarizer);
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
  if (entry.kind === "eval") {
    const { scores } = entry;
    const recall = scores.recall === null ? "-" : `${scores.found}/${scores.bugs}`;
    const clean = scores.findingsPerCleanCase?.toFixed(2) ?? "-";
    return `recall ${recall}, ${clean} per clean`;
  }
  if (entry.findings === null) return "-";
  if (entry.verdicts === null) return String(entry.findings);
  return `${entry.findings} (${entry.verdicts.confirmed} confirmed)`;
}

/** Newest first. */
export function formatRuns(entries: readonly IndexEntry[], options: TableOptions): string {
  if (entries.length === 0) return "No runs yet.";
  const paint = painter(options);

  const rows = [
    ["Run", "Status", "Harness", "Models", "Diff", "Findings", "Cost", "Time"],
    ...entries
      .toReversed()
      .map((e) => [
        e.id,
        e.status,
        e.harness,
        describeModels(e.models),
        e.kind === "eval"
          ? `eval: ${e.cases} ${e.subset ? `${e.subset} ` : ""}cases`
          : `${e.diff.files} files +${e.diff.additions} -${e.diff.deletions}`,
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

type Paint = (style: Style, text: string) => string;

function painter(options: TableOptions): Paint {
  return (style, text) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;
}

/** Cost, time, and calls per step, then the totals, with deltas. */
function stepTable(a: StepTotals, b: StepTotals, paint: Paint): string[] {
  const [header = "", ...lines] = table(
    [
      ["Step", "Cost A", "Cost B", "Δ cost", "Time A", "Time B", "Δ time", "Calls"],
      ...compareSteps(a, b).map(({ step, a: sa, b: sb }) => [
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
  return [paint("dim", header), ...lines];
}

export function formatCompare(a: LoadedRun, b: LoadedRun, options: TableOptions): string {
  const paint = painter(options);
  const out: string[] = [];

  const info = table([
    ["", "A", "B"],
    ["Run", a.id, b.id],
    ["Harness", a.run.harness, b.run.harness],
    ["Summarizer", summarizerOf(a.run), summarizerOf(b.run)],
    ["Reviewer", shortModel(a.run.models.reviewer), shortModel(b.run.models.reviewer)],
    ["Verifier", shortModel(a.run.models.verifier), shortModel(b.run.models.verifier)],
    ["Diff", diffOf(a), diffOf(b)],
    ["Status", a.run.status, b.run.status],
  ]);
  out.push(...info, "");

  out.push(...stepTable(a.run, b.run, paint), "");

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

interface Metric {
  label: string;
  cell: (s: EvalScores) => string;
  delta: (a: EvalScores, b: EvalScores) => string;
}

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

function recallMetric(name: string, found: (s: EvalScores) => number): Metric {
  const recall = (s: EvalScores) => (s.bugs === 0 ? null : found(s) / s.bugs);
  return {
    label: name,
    cell: (s) => {
      const r = recall(s);
      return r === null ? "-" : `${found(s)}/${s.bugs} (${percent(r)})`;
    },
    delta: (a, b) => {
      const [ra, rb] = [recall(a), recall(b)];
      return ra === null || rb === null
        ? "-"
        : signed((rb - ra) * 100, (v) => `${Math.round(v)} pts`);
    },
  };
}

const perCase = (s: EvalScores, value: number) => (s.cases === 0 ? 0 : value / s.cases);

const METRICS: Metric[] = [
  recallMetric("Recall", (s) => s.found),
  recallMetric("Reviewer recall", (s) => s.foundByReviewer),
  {
    label: "Findings per clean case",
    cell: (s) =>
      s.findingsPerCleanCase === null
        ? "-"
        : `${s.findingsPerCleanCase.toFixed(2)} (${s.cleanFindings} in ${s.cleanCases})`,
    delta: (a, b) =>
      a.findingsPerCleanCase === null || b.findingsPerCleanCase === null
        ? "-"
        : signed(b.findingsPerCleanCase - a.findingsPerCleanCase, (v) => v.toFixed(2)),
  },
  {
    label: "Failed cases",
    cell: (s) => `${s.failed}/${s.cases}`,
    delta: (a, b) => signed(b.failed - a.failed, String),
  },
  {
    label: "Cost per case",
    cell: (s) =>
      s.costUsd === null
        ? costCell(null, s.unknownCostCalls)
        : costCell(perCase(s, s.costUsd), s.unknownCostCalls),
    delta: (a, b) =>
      a.unknownCostCalls > 0 || b.unknownCostCalls > 0
        ? "?"
        : a.costUsd === null || b.costUsd === null
          ? "-"
          : signed(perCase(b, b.costUsd) - perCase(a, a.costUsd), formatCost),
  },
  {
    label: "Time per case",
    cell: (s) => formatDuration(perCase(s, s.durationMs)),
    delta: (a, b) => signed(perCase(b, b.durationMs) - perCase(a, a.durationMs), formatDuration),
  },
];

function roughEdgeMetric(
  name: string,
  value: (r: RoughEdgeScores) => number | null,
  cell: (r: RoughEdgeScores, v: number) => string,
  delta: (v: number) => string,
): Metric {
  const of = (s: EvalScores) => (s.roughEdges === undefined ? null : value(s.roughEdges));
  return {
    label: name,
    cell: (s) => {
      if (s.roughEdges === undefined) return "off";
      const v = value(s.roughEdges);
      return v === null ? "-" : cell(s.roughEdges, v);
    },
    delta: (a, b) => {
      const [va, vb] = [of(a), of(b)];
      return va === null || vb === null ? "-" : signed(vb - va, delta);
    },
  };
}

const pts = (v: number) => `${Math.round(v * 100)} pts`;

/** A rate of the rubric judge's scores, such as `40% (4 of 10 kept)`; `-` when not judged. */
function judgeRateMetric(
  name: string,
  rate: (j: RoughEdgeJudgeScores) => [number | null, number, number],
  of: string,
): Metric {
  return roughEdgeMetric(
    name,
    (r) => (r.judge === undefined ? null : rate(r.judge)[0]),
    (r, v) => {
      const [, n, d] = rate(r.judge!);
      return `${percent(v)} (${n} of ${d}${of})`;
    },
    pts,
  );
}

/** Shown when either eval ran with rough edges. */
const ROUGH_EDGE_METRICS: Metric[] = [
  roughEdgeMetric(
    "Rough edges kept per case",
    (r) => r.keptPerCase,
    (r, v) =>
      `${v.toFixed(2)} (${r.accurate} accurate, ${r.unclear} unclear; ${r.inaccurate} dropped)`,
    (v) => v.toFixed(2),
  ),
  roughEdgeMetric(
    "Rough edges kept per clean case",
    (r) => r.keptPerCleanCase,
    (_, v) => v.toFixed(2),
    (v) => v.toFixed(2),
  ),
  roughEdgeMetric(
    "Rough edge check cost per case",
    (r) => (r.checkCostUsd === null || r.cases === 0 ? null : r.checkCostUsd / r.cases),
    (r, v) => `${r.unknownCheckCost > 0 ? "≥" : ""}${formatCost(v)}`,
    formatCost,
  ),
  judgeRateMetric(
    "Rough edges postable (judge)",
    (j) => [j.postableRate, j.postable, j.graded],
    "",
  ),
  judgeRateMetric(
    "Checker kept, judge rejects",
    (j) => [j.keptRejectedRate, j.keptRejected, j.kept],
    " kept",
  ),
  judgeRateMetric(
    "Checker dropped, judge accepts",
    (j) => [j.droppedAcceptedRate, j.droppedAccepted, j.dropped],
    " dropped",
  ),
];

function metricsFor(...scores: EvalScores[]): Metric[] {
  return scores.some((s) => s.roughEdges !== undefined)
    ? [...METRICS, ...ROUGH_EDGE_METRICS]
    : METRICS;
}

/** The eval command's summary: the result per case, the scores, and the run dir. */
export function formatEval(result: EvalRunResult, options: TableOptions): string {
  const paint = painter(options);
  const edges = result.cases.some((c) => c.roughEdges !== undefined);
  const [caseHeader = "", ...caseLines] = table(
    [
      ["Case", "Kind", "Result", ...(edges ? ["Rough edges"] : []), "Cost", "Time"],
      ...result.cases.map((c) => [
        c.id,
        c.kind,
        caseOutcome(c),
        ...(edges ? [roughEdgeCell(c)] : []),
        costCell(c.costUsd, c.unknownCostCalls),
        formatDuration(c.durationMs),
      ]),
    ],
    edges ? new Set([4, 5]) : new Set([3, 4]),
  );
  const out = [paint("dim", caseHeader), ...caseLines, ""];
  for (const { id, error } of result.cases) {
    if (error !== null) out.push(paint("red", `${id}: ${error.split("\n")[0]}`));
  }
  if (out.at(-1) !== "") out.push("");
  const { locationRecall, judgeCostUsd } = result.scores;
  const rows = metricsFor(result.scores).map((m) => [m.label, m.cell(result.scores)]);
  if (locationRecall !== undefined && locationRecall !== null) {
    rows.splice(1, 0, ["Recall by location only", percent(locationRecall)]);
  }
  if (judgeCostUsd !== undefined && judgeCostUsd !== null) {
    rows.push(["Judge cost (not in cost above)", formatCost(judgeCostUsd)]);
  }
  const edgeJudge = result.scores.roughEdges?.judge;
  if (edgeJudge !== undefined) {
    const { accurate, notLocal, concrete, worthPosting } = edgeJudge.no;
    rows.push([
      "Rubric no answers",
      `accurate ${accurate}, not local ${notLocal}, concrete ${concrete}, worth posting ${worthPosting}`,
    ]);
    if (edgeJudge.failed > 0) rows.push(["Rough-edge judge failed", `${edgeJudge.failed} case(s)`]);
    if (edgeJudge.costUsd !== null) {
      rows.push(["Rough-edge judge cost (not in cost above)", formatCost(edgeJudge.costUsd)]);
    }
  }
  out.push(...table(rows));
  out.push("", `Eval run: ${result.root}`);
  return out.join("\n");
}

/** Kept of all, such as `2/3`; `-` for a failed case. */
function roughEdgeCell(c: CaseResult): string {
  const r = c.roughEdges;
  if (r == null) return "-";
  return `${r.accurate + r.unclear}/${r.accurate + r.unclear + r.inaccurate}`;
}

const byId = (cases: readonly CaseResult[]) => new Map(cases.map((c) => [c.id, c]));

function casesOf({ run }: LoadedEval): string {
  return `${run.dataset.cases.length}${run.dataset.subset ? ` (${run.dataset.subset})` : ""}`;
}

export function formatEvalCompare(a: LoadedEval, b: LoadedEval, options: TableOptions): string {
  const paint = painter(options);
  const out: string[] = [];

  out.push(
    ...table([
      ["", "A", "B"],
      ["Eval", a.id, b.id],
      ["Harness", a.run.harness, b.run.harness],
      ["Summarizer", summarizerOf(a.run), summarizerOf(b.run)],
      ["Reviewer", shortModel(a.run.models.reviewer), shortModel(b.run.models.reviewer)],
      ["Verifier", shortModel(a.run.models.verifier), shortModel(b.run.models.verifier)],
      ["Cases", casesOf(a), casesOf(b)],
      ["Status", a.run.status, b.run.status],
    ]),
    "",
  );

  const [scoreHeader = "", ...scoreLines] = table(
    [
      ["Score", "A", "B", "Δ"],
      ...metricsFor(a.run.scores, b.run.scores).map((m) => [
        m.label,
        m.cell(a.run.scores),
        m.cell(b.run.scores),
        m.delta(a.run.scores, b.run.scores),
      ]),
    ],
    new Set([1, 2, 3]),
  );
  out.push(paint("dim", scoreHeader), ...scoreLines, "");
  out.push(...stepTable(a.run, b.run, paint), "");

  const casesA = byId(a.cases);
  const casesB = byId(b.cases);
  const onlyA = [...casesA.keys()].filter((id) => !casesB.has(id));
  const onlyB = [...casesB.keys()].filter((id) => !casesA.has(id));
  if (onlyA.length > 0 || onlyB.length > 0) {
    out.push(
      paint("yellow", "The evals ran different cases, so their scores cover different sets."),
    );
    if (onlyA.length > 0) out.push(`Only in A: ${onlyA.join(", ")}`);
    if (onlyB.length > 0) out.push(`Only in B: ${onlyB.join(", ")}`);
    out.push("");
  }

  const shared = [...casesA.values()].flatMap((ca) => {
    const cb = casesB.get(ca.id);
    return cb === undefined ? [] : [[ca, cb] as const];
  });
  const changed = shared.filter(([ca, cb]) => caseOutcome(ca) !== caseOutcome(cb));
  out.push(paint("bold", `Cases: ${changed.length} of ${shared.length} shared cases changed`));
  if (changed.length > 0) {
    out.push("");
    for (const line of table(
      changed.map(([ca, cb]) => [ca.id, ca.kind, caseOutcome(ca), "→", caseOutcome(cb)]),
    )) {
      out.push(`  ${line}`);
    }
  }
  return out.join("\n");
}

const MAX_REASON_CHARS = 100;

/** A judge's reason, cut to one table cell. */
const reason = (text: string | null) =>
  text === null
    ? ""
    : text.length > MAX_REASON_CHARS
      ? `${text.slice(0, MAX_REASON_CHARS - 1)}…`
      : text;

/** The pairwise judge's verdict per case, and the tally: which eval's rough edges it prefers. */
export function formatPairwise(record: PairwiseRecord, options: TableOptions): string {
  const paint = painter(options);
  const [a, b] = [path.basename(record.a), path.basename(record.b)];
  const [header = "", ...lines] = table(
    [
      ["Case", "Preferred", "Kept A", "Kept B", "Reason"],
      ...record.cases.map((c) => [
        c.id,
        c.winner === null ? "failed" : c.winner === "tie" ? "tie" : c.winner.toUpperCase(),
        String(c.kept.a),
        String(c.kept.b),
        reason(c.winner === null ? c.error : c.reason),
      ]),
    ],
    new Set([2, 3]),
  );
  const { scores } = record;
  const rows = [
    ["A", a],
    ["B", b],
    ["Judge", describeModel(record.judge)],
    ["Preferred", `A ${scores.aWins}, B ${scores.bWins}, tie ${scores.ties} (of ${scores.cases})`],
    ["B win rate (ties count half)", scores.bWinRate === null ? "-" : percent(scores.bWinRate)],
  ];
  if (scores.failed > 0) rows.push(["Failed", `${scores.failed} case(s)`]);
  if (scores.costUsd !== null) rows.push(["Judge cost", formatCost(scores.costUsd)]);
  return [
    "Rough edges, judged pairwise and blind",
    "",
    paint("dim", header),
    ...lines,
    "",
    ...table(rows),
    "",
    `Saved: ${path.join(record.a, `pairwise-${b}.json`)}`,
  ].join("\n");
}
