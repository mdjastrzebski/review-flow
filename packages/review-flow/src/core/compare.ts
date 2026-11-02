import path from "node:path";
import type { Step, TimedTotals } from "./calls.ts";
import { evalRunPaths, type EvalRunRecord } from "./eval.ts";
import type { CaseResult } from "./eval-score.ts";
import { readJsonOrNull } from "./json.ts";
import type { RunRecord } from "./pipeline.ts";
import { runDirPaths } from "./run-dir.ts";
import type { NormalizedFinding, Verdict } from "./schemas.ts";

export interface LoadedRun {
  kind: "review";
  id: string;
  run: RunRecord;
  /** null when the run failed before the reviewer returned. */
  findings: NormalizedFinding[] | null;
  /** null when the run failed before verification finished. */
  verdicts: Record<string, Verdict> | null;
}

export interface LoadedEval {
  kind: "eval";
  id: string;
  run: EvalRunRecord;
  cases: CaseResult[];
}

export async function loadRun(root: string): Promise<LoadedRun | LoadedEval> {
  const paths = runDirPaths(root);
  const run = await readJsonOrNull<RunRecord | EvalRunRecord>(paths.runJsonPath);
  if (run === null) throw new Error(`No run.json in ${root}`);
  if (run.steps === undefined || run.totals === undefined) {
    throw new Error(`${root}/run.json predates per-step records and can't be compared.`);
  }
  if ("kind" in run) {
    const cases = await readJsonOrNull<CaseResult[]>(evalRunPaths(root).casesPath);
    return { kind: "eval", id: path.basename(root), run, cases: cases ?? [] };
  }
  return {
    kind: "review",
    id: path.basename(root),
    run: run as RunRecord,
    findings: await readJsonOrNull(paths.findingsPath),
    verdicts: await readJsonOrNull(paths.verdictsPath),
  };
}

export interface StepComparison {
  step: Step | "total";
  a: TimedTotals | null;
  b: TimedTotals | null;
}

/** Steps in run order (a's first, then any only b ran), then the run totals. */
export function compareSteps(
  a: Pick<RunRecord, "steps" | "totals">,
  b: Pick<RunRecord, "steps" | "totals">,
): StepComparison[] {
  const steps = [...new Set([...Object.keys(a.steps), ...Object.keys(b.steps)])] as Step[];
  return [
    ...steps.map((step) => ({ step, a: a.steps[step] ?? null, b: b.steps[step] ?? null })),
    { step: "total" as const, a: a.totals, b: b.totals },
  ];
}

/** Line distance at which two findings in the same file still count as the same one. */
export const MATCH_TOLERANCE_LINES = 3;

export interface FindingMatch {
  both: [NormalizedFinding, NormalizedFinding][];
  onlyA: NormalizedFinding[];
  onlyB: NormalizedFinding[];
}

/** Lines between two ranges; 0 when they overlap. */
function gap(a: NormalizedFinding, b: NormalizedFinding): number {
  return Math.max(0, a.lineStart - b.lineEnd, b.lineStart - a.lineEnd);
}

/**
 * Pairs findings one-to-one: same file and line ranges within the tolerance, closest pairs first.
 * Only meaningful when both runs reviewed the same head; otherwise lines may have moved.
 */
export function matchFindings(
  a: readonly NormalizedFinding[],
  b: readonly NormalizedFinding[],
): FindingMatch {
  const candidates = a
    .flatMap((fa, i) =>
      b.map((fb, j) => ({ i, j, gap: gap(fa, fb), offset: Math.abs(fa.lineStart - fb.lineStart) })),
    )
    .filter((c) => a[c.i]?.file === b[c.j]?.file && c.gap <= MATCH_TOLERANCE_LINES)
    .toSorted((x, y) => x.gap - y.gap || x.offset - y.offset || x.i - y.i || x.j - y.j);

  const pairs = new Map<number, number>();
  const usedB = new Set<number>();
  for (const { i, j } of candidates) {
    if (pairs.has(i) || usedB.has(j)) continue;
    pairs.set(i, j);
    usedB.add(j);
  }
  return {
    both: [...pairs]
      .toSorted(([x], [y]) => x - y)
      .map(([i, j]) => [a[i], b[j]] as [NormalizedFinding, NormalizedFinding]),
    onlyA: a.filter((_, i) => !pairs.has(i)),
    onlyB: b.filter((_, j) => !usedB.has(j)),
  };
}
