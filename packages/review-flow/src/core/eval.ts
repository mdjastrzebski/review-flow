import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunAgent } from "./agent.ts";
import { addTotals, EMPTY_TOTALS, type Step, type TimedTotals } from "./calls.ts";
import { checkoutName, type EvalCase, type EvalSubset } from "./eval-dataset.ts";
import { fetchFixDiffs } from "./eval-fixes.ts";
import { judgeCase, type JudgeResult } from "./eval-judge.ts";
import {
  countReported,
  judgeBugs,
  scoreBugs,
  summarizeCases,
  type BugResult,
  type CaseResult,
  type EvalScores,
  type JudgeCall,
} from "./eval-score.ts";
import { describeModel, formatCost, formatDuration } from "./format.ts";
import { checkoutDetached, ensureClone, resolveRepoRoot, WorkingTreeChangedError } from "./git.ts";
import { readJsonOrNull, writeJson } from "./json.ts";
import type { Harness, ModelChoice, RoleModels } from "./models.ts";
import {
  runReview,
  type ReviewRunOptions,
  type ReviewRunResult,
  type RunRecord,
} from "./pipeline.ts";
import type { TaskActivity } from "./task.ts";
import { ensureStateDir, formatRunTimestamp, runDirPaths } from "./run-dir.ts";
import { appendIndexEntry, runsPath } from "./run-index.ts";
import type { NormalizedFinding, Verdict } from "./schemas.ts";
import type { Trust } from "./trust.ts";

export interface EvalRunOptions {
  /** Any directory inside the repository the eval run is saved in. */
  cwd: string;
  cases: readonly EvalCase[];
  /** Recorded in run.json. */
  dataset: string;
  subset?: EvalSubset | undefined;
  /** Run Summarize on each case (default: true). */
  summarize?: boolean;
  /** One clone per case repo, reused across evals. */
  checkoutsDir: string;
  /** Model of the judge that matches findings to known bugs; absent: match by location alone. */
  judge?: ModelChoice | undefined;
  /** Where fix diffs are cached; the judge reads each bug's fix diff. Absent: description only. */
  fixesDir?: string | undefined;
  harness: Harness;
  models: RoleModels;
  runAgent: RunAgent;
  log: (message: string) => void;
  warn?: (message: string) => void;
  logTable?: ReviewRunOptions["logTable"];
  onActivity?: (activity: TaskActivity) => void;
  verbose?: boolean;
}

/** run.json of an eval run. */
export interface EvalRunRecord {
  kind: "eval";
  harness: Harness;
  models: RoleModels;
  dataset: { dir: string; subset: EvalSubset | null; cases: string[] };
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

/** Cases are merged PRs of public repos: third-party code, but reviewed by its maintainers. */
const EVAL_CASE_TRUST: Trust = { level: "collaborator", reason: "eval case, a merged PR" };

/** The judge's scoring of a case: the bugs it decided, or none when the judge failed. */
async function judgeBugsOf(
  evalCase: EvalCase,
  findings: readonly NormalizedFinding[],
  verdicts: Readonly<Record<string, Verdict>>,
  caseRoot: string,
  model: ModelChoice,
  runAgent: RunAgent,
  fixesDir: string | undefined,
): Promise<{ bugs: BugResult[] | null; call: JudgeCall }> {
  let result: JudgeResult;
  try {
    const fixDiffs = fixesDir === undefined ? [] : await fetchFixDiffs(evalCase.bugs, fixesDir);
    result = await judgeCase({ evalCase, findings, fixDiffs, cwd: caseRoot, model, runAgent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { status: "failed", error: message, costUsd: null, durationMs: 0 };
  }
  const call: JudgeCall = {
    status: result.status,
    error: result.status === "failed" ? result.error : null,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
  if (result.status === "failed") return { bugs: null, call };
  await writeJson(path.join(caseRoot, "judge.json"), result.output);
  return { bugs: judgeBugs(evalCase.bugs, findings, verdicts, result.matches), call };
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
      trust: EVAL_CASE_TRUST,
      harness: options.harness,
      models: options.models,
      runAgent: options.runAgent,
      log: (message) => options.log(`  ${message}`),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
      // The eval's own table covers the setup; per case, only --verbose keeps the details.
      logTable: (_, rows) => {
        if (!options.verbose) return;
        for (const [label, value] of rows) options.log(`  ${label}: ${value}`);
      },
      ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      runRoot: caseRoot,
      // Evals score findings only; rough edges are measured apart (PLAN).
      roughEdges: false,
      ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
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
  let bugs: BugResult[] | null =
    review === null ? null : scoreBugs(evalCase.bugs, review.findings, review.verdicts);
  let judge: JudgeCall | null = null;
  if (review !== null && options.judge !== undefined && evalCase.bugs.length > 0) {
    const judged = await judgeBugsOf(
      evalCase,
      review.findings,
      review.verdicts,
      caseRoot,
      options.judge,
      options.runAgent,
      options.fixesDir,
    );
    judge = judged.call;
    bugs = judged.bugs ?? bugs;
    if (judged.call.status === "failed") {
      options.warn?.(
        `${evalCase.id}: the judge failed (${judged.call.error ?? "no result"}); scored by location.`,
      );
    }
  }
  const result: CaseResult = {
    id: evalCase.id,
    kind: evalCase.kind,
    preset: evalCase.preset,
    status: review === null ? "failed" : "ok",
    error,
    findings: findings?.length ?? null,
    reported: review === null ? null : countReported(review.verdicts),
    bugs,
    costUsd: run?.totals.costUsd ?? null,
    unknownCostCalls: run?.totals.unknownCostCalls ?? 0,
    durationMs: run?.totals.durationMs ?? 0,
    ...(judge === null ? {} : { judge }),
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
  const setup: [string, string][] = [["Harness", harness]];
  if (options.summarize ?? true) setup.push(["Summarizer", describeModel(models.summarizer)]);
  setup.push(
    ["Reviewer", describeModel(models.reviewer)],
    ["Verifier", describeModel(models.verifier)],
    ["Cases", `${options.cases.length}${options.subset ? ` (${options.subset} set)` : ""}`],
    ["Dataset", options.dataset],
    ["Run dir", root],
  );
  if (options.logTable === undefined) {
    for (const [label, value] of setup) log(`${label}: ${value}`);
  } else {
    options.logTable("Eval", setup);
  }

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
        subset: options.subset ?? null,
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
      subset: options.subset ?? null,
      cases: options.cases.length,
      scores,
      costUsd: totals.costUsd,
      unknownCostCalls: totals.unknownCostCalls,
    });
  }
}

const RESCORE_CONCURRENCY = 4;

export interface RescoreOptions {
  /** The eval run dir to score again. */
  root: string;
  /** Its cases, from the dataset. */
  cases: readonly EvalCase[];
  judge: ModelChoice;
  /** Where fix diffs are cached; absent: the judge gets the bug's description only. */
  fixesDir?: string | undefined;
  runAgent: RunAgent;
  log: (message: string) => void;
  warn?: (message: string) => void;
}

/** rescore.json of an eval run. */
export interface RescoreRecord {
  rescoredAt: string;
  judge: ModelChoice;
  cases: CaseResult[];
  scores: EvalScores;
}

/**
 * Scores a finished eval again with the judge, from the findings and verdicts its case run dirs
 * kept; no checkout, reviewer, or verifier runs. The eval's own files stay as they were, and the
 * result goes in `rescore.json` beside them.
 */
export async function rescoreEval(options: RescoreOptions): Promise<EvalRunResult> {
  const paths = evalRunPaths(options.root);
  const previous = (await readJsonOrNull<CaseResult[]>(paths.casesPath)) ?? [];
  const dataset = new Map(options.cases.map((c) => [c.id, c]));
  const results: CaseResult[] = [...previous];

  const rescoreOne = async (old: CaseResult, index: number): Promise<void> => {
    const evalCase = dataset.get(old.id);
    if (old.status !== "ok" || evalCase === undefined || evalCase.bugs.length === 0) return;
    const caseRoot = paths.caseRoot(old.id);
    const caseRun = runDirPaths(caseRoot);
    const findings = await readJsonOrNull<NormalizedFinding[]>(caseRun.findingsPath);
    const verdicts = await readJsonOrNull<Record<string, Verdict>>(caseRun.verdictsPath);
    if (findings === null || verdicts === null) {
      options.warn?.(`${old.id}: no findings or verdicts saved; kept its score.`);
      return;
    }
    const judged = await judgeBugsOf(
      evalCase,
      findings,
      verdicts,
      caseRoot,
      options.judge,
      options.runAgent,
      options.fixesDir,
    );
    if (judged.call.status === "failed") {
      options.warn?.(
        `${old.id}: the judge failed (${judged.call.error ?? "no result"}); kept its score.`,
      );
    }
    results[index] = { ...old, bugs: judged.bugs ?? old.bugs, judge: judged.call };
    options.log(`  ${old.id}: ${caseOutcome(old)} → ${caseOutcome(results[index])}`);
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(RESCORE_CONCURRENCY, previous.length) }, async () => {
      while (next < previous.length) {
        const index = next++;
        const old = previous[index];
        if (old !== undefined) await rescoreOne(old, index);
      }
    }),
  );

  const scores = summarizeCases(results);
  const record: RescoreRecord = {
    rescoredAt: new Date().toISOString(),
    judge: options.judge,
    cases: results,
    scores,
  };
  await writeJson(path.join(options.root, "rescore.json"), record);
  return { root: options.root, cases: results, scores };
}
