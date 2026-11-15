import path from "node:path";
import { readJsonOrNull } from "../runtime/json.ts";
import { flattenTree, RECORD_FORMAT, type FlowNode, type TimedTotals } from "../runtime/records.ts";
import type { RunRecord } from "./flows/review.ts";
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

/** run.json of a run to compare; runs from before the flow tree can't be. */
export async function readRunRecord<T>(root: string): Promise<T> {
  const run = await readJsonOrNull<{ format?: number }>(runDirPaths(root).runJsonPath);
  if (run === null) throw new Error(`No run.json in ${root}`);
  if (run.format !== RECORD_FORMAT) {
    throw new Error(
      `Run ${path.basename(root)} uses the old record format; per-step comparison needs runs from this version.`,
    );
  }
  return run as T;
}

export async function loadReviewRun(root: string, run: RunRecord): Promise<LoadedRun> {
  const paths = runDirPaths(root);
  return {
    kind: "review",
    id: path.basename(root),
    run,
    findings: await readJsonOrNull(paths.findingsPath),
    verdicts: await readJsonOrNull(paths.verdictsPath),
  };
}

export interface StepComparison {
  /** A path in the flow tree, such as `find/verify`, or `total`. */
  step: string;
  a: TimedTotals | null;
  b: TimedTotals | null;
}

/** What compareSteps reads: the tree (null while running) and the totals. */
export interface StepTotals {
  flow: FlowNode | null;
  totals: TimedTotals;
}

/**
 * Each path of the flow trees in run order (a's first, then any only b ran), then the run totals.
 * An eval's cases are summed per path.
 */
export function compareSteps(a: StepTotals, b: StepTotals): StepComparison[] {
  const [stepsA, stepsB] = [flattenTree(a.flow), flattenTree(b.flow)];
  const steps = [...new Set([...stepsA.keys(), ...stepsB.keys()])];
  return [
    ...steps.map((step) => ({ step, a: stepsA.get(step) ?? null, b: stepsB.get(step) ?? null })),
    { step: "total", a: a.totals, b: b.totals },
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
