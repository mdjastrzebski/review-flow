import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunAgent } from "./agent.ts";
import { addTotals, EMPTY_TOTALS, type Step, type TimedTotals } from "./calls.ts";
import { checkoutName, type EvalCase } from "./eval-dataset.ts";
import {
  countReported,
  scoreBugs,
  summarizeCases,
  type CaseResult,
  type EvalScores,
} from "./eval-score.ts";
import { formatCost, formatDuration } from "./format.ts";
import { checkoutDetached, ensureClone, resolveRepoRoot, WorkingTreeChangedError } from "./git.ts";
import { readJsonOrNull, writeJson } from "./json.ts";
import type { Harness, RoleModels } from "./models.ts";
import { runReview, type ReviewRunResult, type RunRecord } from "./pipeline.ts";
import { ensureStateDir, formatRunTimestamp, runDirPaths } from "./run-dir.ts";
import { appendIndexEntry, runsPath } from "./run-index.ts";
import type { NormalizedFinding } from "./schemas.ts";

export interface EvalRunOptions {
  /** Any directory inside the repository the eval run is saved in. */
  cwd: string;
  cases: readonly EvalCase[];
  /** Recorded in run.json. */
  dataset: string;
  smoke: boolean;
  /** One clone per case repo, reused across evals. */
  checkoutsDir: string;
  harness: Harness;
  models: RoleModels;
  runAgent: RunAgent;
  log: (message: string) => void;
}

/** run.json of an eval run. */
export interface EvalRunRecord {
  kind: "eval";
  harness: Harness;
  models: RoleModels;
  dataset: { dir: string; smoke: boolean; cases: string[] };
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  error: string | null;
  /** Each step summed over cases; time is the sum of the cases' step times. */
  steps: Partial<Record<Step, TimedTotals>>;
  /** Calls and cost summed over cases; time is the eval's wall time, clones included. */
  totals: TimedTotals;
  scores: EvalScores;
}

export interface EvalRunResult {
  root: string;
  cases: CaseResult[];
  scores: EvalScores;
}

export function evalRunPaths(root: string) {
  return {
    runJsonPath: path.join(root, "run.json"),
    casesPath: path.join(root, "cases.json"),
    caseRoot: (id: string) => path.join(root, "cases", id),
  };
}

/** `found`, `refuted` (only refuted findings hit the bug), `missed`, `N findings`, or `failed`. */
export function caseOutcome(result: CaseResult): string {
  if (result.status === "failed" || result.bugs === null) return "failed";
  if (result.kind === "clean")
    return `${result.reported} finding${result.reported === 1 ? "" : "s"}`;
  if (result.bugs.every((b) => b.found)) return "found";
  if (result.bugs.some((b) => b.found)) {
    return `found ${result.bugs.filter((b) => b.found).length}/${result.bugs.length}`;
  }
  return result.bugs.some((b) => b.foundByReviewer) ? "refuted" : "missed";
}

/** Outcome, cost, and time; plus the error of a failed case. */
export function describeCase(result: CaseResult): string {
  const parts = [caseOutcome(result)];
  if (result.costUsd !== null) {
    parts.push(`${result.unknownCostCalls > 0 ? "≥" : ""}${formatCost(result.costUsd)}`);
  }
  parts.push(formatDuration(result.durationMs));
  const text = parts.join(", ");
  return result.error === null ? text : `${text}: ${result.error.split("\n")[0]}`;
}

/**
 * Clones (or reuses) the case repo, checks out the case head, and reviews it against the base.
 * Failures are recorded on the case; a changed working tree is rethrown to stop the eval.
 */
async function runCase(
  evalCase: EvalCase,
  caseRoot: string,
  options: EvalRunOptions,
): Promise<{ result: CaseResult; run: RunRecord | null }> {
  let review: ReviewRunResult | null = null;
  let error: string | null = null;
  try {
    const checkout = path.join(options.checkoutsDir, checkoutName(evalCase.repo));
    await ensureClone(evalCase.repo, checkout, [evalCase.base, evalCase.head]);
    await checkoutDetached(checkout, evalCase.head);
    review = await runReview({
      cwd: checkout,
      base: evalCase.base,
      harness: options.harness,
      models: options.models,
      runAgent: options.runAgent,
      log: (message) => options.log(`  ${message}`),
      runRoot: caseRoot,
      // The checkout is clean; this also keeps a stray file out of the scored diff.
      committedOnly: true,
    });
  } catch (caught) {
    // Agents wrote to the checkout despite read-only settings: stop rather than carry on.
    if (caught instanceof WorkingTreeChangedError) throw caught;
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // Written even by a failed review, unless it failed before making its run dir.
  const paths = runDirPaths(caseRoot);
  const run = await readJsonOrNull<RunRecord>(paths.runJsonPath);
  const findings =
    review?.findings ?? (await readJsonOrNull<NormalizedFinding[]>(paths.findingsPath));
  const result: CaseResult = {
    id: evalCase.id,
    kind: evalCase.kind,
    smoke: evalCase.smoke,
    status: review === null ? "failed" : "ok",
    error,
    findings: findings?.length ?? null,
    reported: review === null ? null : countReported(review.verdicts),
    bugs: review === null ? null : scoreBugs(evalCase.bugs, review.findings, review.verdicts),
    costUsd: run?.totals.costUsd ?? null,
    unknownCostCalls: run?.totals.unknownCostCalls ?? 0,
    durationMs: run?.totals.durationMs ?? 0,
  };
  return { result, run };
}

function sumSteps(runs: readonly RunRecord[]): Partial<Record<Step, TimedTotals>> {
  const steps: Partial<Record<Step, TimedTotals>> = {};
  for (const run of runs) {
    for (const [step, totals] of Object.entries(run.steps) as [Step, TimedTotals][]) {
      steps[step] = addTotals(steps[step] ?? EMPTY_TOTALS, totals);
    }
  }
  return steps;
}

/**
 * Reviews each case in turn and scores the findings. The eval run goes in the repo's
 * `.review-flow/runs/<timestamp>-eval/`, with a run dir per case under `cases/`, and is indexed.
 * cases.json is rewritten after each case, so an interrupted eval keeps what it finished.
 */
export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const { harness, models, log } = options;
  const startedAt = new Date();
  const repo = await resolveRepoRoot(options.cwd);
  await ensureStateDir(repo);

  await mkdir(runsPath(repo), { recursive: true });
  const root = path.join(runsPath(repo), `${formatRunTimestamp(startedAt)}-eval`);
  // Non-recursive so two evals in the same second fail loudly instead of sharing a directory.
  await mkdir(root);
  await mkdir(path.join(root, "cases"));
  const paths = evalRunPaths(root);
  log(`Eval run dir: ${root}`);

  const results: CaseResult[] = [];
  const runs: RunRecord[] = [];
  let failure: string | null = null;
  try {
    for (const [index, evalCase] of options.cases.entries()) {
      log(`[${index + 1}/${options.cases.length}] ${evalCase.id} (${evalCase.kind})`);
      const { result, run } = await runCase(evalCase, paths.caseRoot(evalCase.id), options);
      results.push(result);
      if (run !== null) runs.push(run);
      log(`  → ${evalCase.id}: ${describeCase(result)}`);
      await writeJson(paths.casesPath, results);
    }
    return { root, cases: results, scores: summarizeCases(results) };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const finishedAt = new Date();
    const scores = summarizeCases(results);
    const totals: TimedTotals = {
      ...runs.map((r) => r.totals).reduce(addTotals, EMPTY_TOTALS),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    const record: EvalRunRecord = {
      kind: "eval",
      harness,
      models,
      dataset: {
        dir: options.dataset,
        smoke: options.smoke,
        cases: options.cases.map((c) => c.id),
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: failure === null ? "ok" : "failed",
      error: failure,
      steps: sumSteps(runs),
      totals,
      scores,
    };
    await writeJson(paths.runJsonPath, record);
    await appendIndexEntry(repo, {
      id: path.basename(root),
      kind: "eval",
      startedAt: record.startedAt,
      durationMs: totals.durationMs,
      status: record.status,
      harness,
      models,
      smoke: options.smoke,
      cases: options.cases.length,
      scores,
      costUsd: totals.costUsd,
      unknownCostCalls: totals.unknownCostCalls,
    });
  }
}
