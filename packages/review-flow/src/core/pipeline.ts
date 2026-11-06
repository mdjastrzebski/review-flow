import { writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { AgentStatus, RunAgent } from "./agent.ts";
import { EMPTY_TOTALS, rollUp, type CallRecord, type Step, type TimedTotals } from "./calls.ts";
import {
  commitMessages,
  diffAgainstBase,
  resolveCommit,
  resolveRepoRoot,
  shortSha,
  snapshotStatus,
  snapshotWorkingTree,
} from "./git.ts";
import { describeModel, formatDuration } from "./format.ts";
import type { PullRequest } from "./github.ts";
import { writeJson } from "./json.ts";
import type { Harness, RoleModels } from "./models.ts";
import { normalizeFindings, normalizeRoughEdges } from "./normalize.ts";
import { codeFence, loadPrompt, renderPrompt } from "./prompts.ts";
import { createRunDir, createRunDirAt, ensureStateDir, type RunDir } from "./run-dir.ts";
import {
  appendIndexEntry,
  countVerdicts,
  diffStats,
  readIndex,
  type DiffStats,
  type VerdictCounts,
} from "./run-index.ts";
import { applyVerdictRules } from "./rank.ts";
import { renderReport } from "./report.ts";
import {
  ROUGH_EDGE_CHECKER_TASK_ID,
  applyChecks,
  buildRoughEdgeCheckerPrompt,
} from "./rough-edges.ts";
import { formatElapsed, runTask, type TaskActivity, type TaskContext } from "./task.ts";
import { estimateCost, type CostEstimate, type Trust, type TrustLevel } from "./trust.ts";
import {
  FindingsOutput,
  lenientReviewOutput,
  type ReviewOutput,
  RoughEdgeChecks,
  Summary,
  Verdict,
  type CheckedRoughEdge,
  type NormalizedFinding,
  type NormalizedRoughEdge,
} from "./schemas.ts";
import {
  buildSummarizerPrompt,
  normalizeSummary,
  type Intent,
  type SummaryOutcome,
} from "./summary.ts";
import {
  buildChangeContext,
  buildVerifierPrompt,
  changeRangeOf,
  verifierTaskId,
  type ChangeRange,
} from "./verify.ts";

const REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;
const VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;
const SUMMARIZER_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFIER_CONCURRENCY = 3;

export interface ReviewRunOptions {
  /** Any directory inside the repository to review. */
  cwd: string;
  base: string;
  /** The target's trust level; recorded, and sets the policies of section 3 of the spec. */
  trust: Trust;
  harness: Harness;
  models: RoleModels;
  runAgent: RunAgent;
  log: (message: string) => void;
  /**
   * Asked before any agent runs on an `external` target, with the diff size and a cost estimate
   * from past runs; false stops the run with a DeclinedError. Without it, external targets run.
   */
  confirmSpend?: (preflight: Preflight) => Promise<boolean>;
  /** A problem that doesn't stop the run, such as a failed verifier. Default: `log`. */
  warn?: (message: string) => void;
  /** The summary, as soon as it is written. Default: a `Summary written` line. */
  onSummary?: (summary: Summary, trust: TrustLevel) => void;
  /**
   * The command that asks about this run from another terminal, shown in the review box.
   * Without it, no such row.
   */
  askCommand?: (runId: string, answerer: { harness: Harness; model: string | null }) => string;
  /** Labelled facts about the run (models, run dir), shown together. Default: one `log` each. */
  logTable?: (title: string, rows: readonly (readonly [string, string])[]) => void;
  /**
   * Live agent activity, for a status line: each tool call or heartbeat, then the end of the task.
   * Without it, each is logged as `  [taskId 0:12] text`.
   */
  onActivity?: (activity: TaskActivity) => void;
  /** Also log run setup, each agent's command and text, tokens per call, and step times. */
  verbose?: boolean;
  /** Review HEAD only; by default uncommitted changes are reviewed too, through a snapshot. */
  committedOnly?: boolean;
  /**
   * Where to create the run dir (an eval case). By default it goes in the repo's
   * `.review-flow/runs/` and is indexed; with a path, the repo's .gitignore and index are left alone.
   */
  runRoot?: string;
  /**
   * The repo whose `.review-flow/` holds the run dir and index, when `cwd` is a review worktree.
   * Default: the reviewed repo.
   */
  stateRepo?: string;
  /** The PR whose head `cwd` is checked out at; recorded so the run can be posted. */
  pr?: PullRequest;
  /** The PR's description, the summary's source for the stated goal. */
  prBody?: string;
  /** Run Summarize, in parallel with Find (default: true). */
  summarize?: boolean;
  /** Run Find and Verify (default: true); `review-flow summary` turns it off. */
  find?: boolean;
  /**
   * Ask the reviewer for rough edges and check them (default: true). Off for evals, which score
   * findings only.
   */
  roughEdges?: boolean;
}

export interface ReviewRunResult {
  runDir: RunDir;
  /** The checkout agents read: the repo root, or the review worktree. */
  checkout: string;
  /** null when Summarize was skipped. */
  summary: SummaryOutcome | null;
  /** Empty when Find was skipped. */
  findings: NormalizedFinding[];
  /** findingId → verdict, with the code-enforced rules applied. */
  verdicts: Record<string, Verdict>;
  /** Checked rough edges, `inaccurate` ones included; empty when not asked for. */
  roughEdges: CheckedRoughEdge[];
  /** null when no call has a reported or computed cost. */
  costUsd: number | null;
  durationMs: number;
}

/**
 * run.json, written as `running` when the run dir is made and again when the run ends. Per-call
 * detail is in calls.jsonl.
 */
export interface RunRecord {
  harness: Harness;
  models: RoleModels;
  base: { ref: string; sha: string };
  /** snapshotSha: the commit holding uncommitted changes that was reviewed instead of HEAD. */
  head: { sha: string; snapshotSha?: string };
  pr?: PullRequest;
  /** Missing in runs from before trust levels. */
  trust?: Trust;
  /** The checkout agents read. Missing in runs from before `ask`. */
  checkout?: string;
  /** Steps the run was started with. Missing in runs from before `ask`. */
  summarize?: boolean;
  find?: boolean;
  roughEdges?: boolean;
  /** The reviewing process, while the run is `running`; a dead pid means it was killed. */
  pid?: number;
  startedAt: string;
  /** null while running. */
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  error: string | null;
  steps: Partial<Record<Step, TimedTotals>>;
  totals: TimedTotals;
}

interface PipelineContext extends TaskContext {
  warn: (message: string) => void;
  onSummary: (summary: Summary, trust: TrustLevel) => void;
  trust: TrustLevel;
  /** Aborted when either branch of the run (summarize, or find and verify) throws. */
  signal: AbortSignal;
}

/** Wall time of each step, in the order the steps ran. */
type StepDurations = Map<Step, number>;

async function timeStep<T>(durations: StepDurations, step: Step, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    durations.set(step, Date.now() - startedAt);
  }
}

/**
 * Stand-in verdict for a verifier that produced no valid output, so every finding still has a
 * verdict. Inconclusive is the honest state: nobody checked the claim.
 */
export function failedVerdict(
  finding: NormalizedFinding,
  status: AgentStatus,
  error: string | null,
): Verdict {
  return {
    verdict: "inconclusive",
    // Unverified, so the reviewer's own severity is all there is to rank by.
    severity: finding.severity,
    confidence: "low",
    fixCost: "small",
    evidence: [],
    summary: `Verification failed (${status}): ${error ?? "no output"}`,
    fix: {
      assessment: "not_applicable",
      detail: "Not assessed; verification failed.",
      betterFix: null,
    },
  };
}

/**
 * One fresh verifier session per finding. Agent failures become inconclusive verdicts; anything
 * thrown (e.g. the working tree changed) stops queued tasks, aborts in-flight ones, and is
 * rethrown once they have settled, so run.json is written after the last task.
 *
 * The first verifier runs alone until it shows activity (or ends). By then its request has
 * written the shared diff to the prompt cache, so the others read it instead of each writing it
 * again; a cache write costs about 40× a cache read.
 */
async function verifyFindings(
  findings: readonly NormalizedFinding[],
  context: { change: ChangeRange; sharedContext: string; models: RoleModels },
  ctx: PipelineContext,
): Promise<Record<string, Verdict>> {
  const template = await loadPrompt("verifier");
  const { sharedContext } = context;
  const warm = Promise.withResolvers<void>();
  // rejectOnClear: otherwise cleared tasks never settle and allSettled hangs.
  const limit = pLimit({
    concurrency: VERIFIER_CONCURRENCY,
    rejectOnClear: true,
  });
  const abort = new AbortController();
  // The summarizer failing stops verification too; its error is the one the run reports.
  ctx.signal.addEventListener("abort", () => abort.abort(ctx.signal.reason), {
    once: true,
  });
  // The first thrown error, in the order thrown; cleared tasks reject later with AbortErrors.
  const errors: unknown[] = [];
  const settled = await Promise.allSettled(
    findings.map((finding, index) =>
      limit(async (): Promise<[string, Verdict]> => {
        try {
          if (index > 0) {
            await warm.promise;
            if (abort.signal.aborted) throw abort.signal.reason;
          }
          const result = await runTask(
            {
              taskId: verifierTaskId(finding),
              role: "verifier",
              prompt: buildVerifierPrompt(template, finding, context.change),
              sharedContext,
              cwd: ctx.repo,
              schema: Verdict,
              model: context.models.verifier.model,
              effort: context.models.verifier.effort,
              timeoutMs: VERIFIER_TIMEOUT_MS,
              signal: abort.signal,
            },
            "verify",
            ctx,
            warm.resolve,
          );
          warm.resolve();
          if (result.output === null) {
            ctx.warn(`${finding.id}: verifier failed (${result.status}); marked inconclusive.`);
            return [finding.id, failedVerdict(finding, result.status, result.error)];
          }
          return [finding.id, applyVerdictRules(result.output)];
        } catch (error) {
          errors.push(error);
          limit.clearQueue();
          abort.abort();
          // After the abort, so waiting verifiers see it and don't start.
          warm.resolve();
          throw error;
        }
      }),
    ),
  );

  if (errors.length > 0) throw errors[0];
  return Object.fromEntries(
    settled.map((s) => (s as PromiseFulfilledResult<[string, Verdict]>).value),
  );
}

/**
 * One batched checker session for all rough edges, on the verifier's model. It runs after the
 * finding verifiers so the shared diff is already cached. A failed or incomplete answer leaves
 * the edges `unclear`; anything thrown stops the run.
 */
async function checkRoughEdges(
  edges: readonly NormalizedRoughEdge[],
  context: {
    change: ChangeRange;
    sharedContext: string;
    models: Pick<RoleModels, "verifier">;
  },
  ctx: PipelineContext,
): Promise<CheckedRoughEdge[]> {
  if (edges.length === 0) return [];
  const result = await runTask(
    {
      taskId: ROUGH_EDGE_CHECKER_TASK_ID,
      role: "verifier",
      prompt: buildRoughEdgeCheckerPrompt(
        await loadPrompt("rough-edge-checker"),
        edges,
        context.change,
      ),
      sharedContext: context.sharedContext,
      cwd: ctx.repo,
      schema: RoughEdgeChecks,
      model: context.models.verifier.model,
      effort: context.models.verifier.effort,
      timeoutMs: VERIFIER_TIMEOUT_MS,
      signal: ctx.signal,
    },
    "check",
    ctx,
  );
  if (result.output === null) {
    const failure = `${result.status}: ${result.error ?? "no output"}`;
    ctx.warn(`Rough edge check failed (${failure}); marked unclear.`);
    return applyChecks(edges, null, failure);
  }
  return applyChecks(edges, result.output, null);
}

/**
 * Verify: the per-finding verifiers, then the batched rough edge check, timed as `check` so its
 * cost shows apart. `edges` is null when rough edges were not asked for; then no
 * rough-edges.json is written.
 */
async function verifyAll(
  findings: readonly NormalizedFinding[],
  edges: readonly NormalizedRoughEdge[] | null,
  context: { change: ChangeRange; sharedContext: string; models: RoleModels },
  stepDurations: StepDurations,
  ctx: PipelineContext,
): Promise<{ verdicts: Record<string, Verdict>; roughEdges: CheckedRoughEdge[] }> {
  const verdicts = await timeStep(stepDurations, "verify", async () => {
    if (findings.length > 0) ctx.log(`Verifying ${findings.length} finding(s)…`);
    const result = await verifyFindings(findings, context, ctx);
    await writeJson(ctx.runDir.verdictsPath, result);
    if (findings.length > 0) {
      const counts = countVerdicts(result);
      ctx.log(
        `Verified: ${counts.confirmed} confirmed, ${counts.inconclusive} inconclusive, ${counts.refuted} refuted`,
      );
    }
    return result;
  });
  if (edges === null) return { verdicts, roughEdges: [] };
  const roughEdges =
    edges.length === 0
      ? []
      : await timeStep(stepDurations, "check", () => checkRoughEdges(edges, context, ctx));
  await writeJson(ctx.runDir.roughEdgesPath, roughEdges);
  return { verdicts, roughEdges };
}

/**
 * One summarizer session. An agent failure leaves the run without a summary instead of failing it;
 * anything thrown (e.g. the working tree changed) stops the run.
 */
async function summarizeChange(
  context: {
    change: ChangeRange;
    sharedContext: string;
    intent: Intent;
    models: RoleModels;
  },
  ctx: PipelineContext,
): Promise<SummaryOutcome> {
  const { model, effort } = context.models.summarizer;
  ctx.log("Summarizing…");
  const result = await runTask(
    {
      taskId: "summarizer",
      role: "summarizer",
      prompt: buildSummarizerPrompt(await loadPrompt("summarizer"), context.change, context.intent),
      sharedContext: context.sharedContext,
      cwd: ctx.repo,
      schema: Summary,
      model,
      effort,
      timeoutMs: SUMMARIZER_TIMEOUT_MS,
      signal: ctx.signal,
    },
    "summarize",
    ctx,
  );
  if (result.output === null) {
    const error = `${result.status}: ${result.error ?? "no output"}`;
    ctx.warn(`Summarizer failed (${error}); the report has no summary.`);
    return { status: "failed", error };
  }
  const summary = normalizeSummary(result.output, ctx.repo);
  await writeJson(ctx.runDir.summaryPath, summary);
  ctx.onSummary(summary, ctx.trust);
  return { status: "ok", summary };
}

/** The branch has no changes against the base; not a failure, just nothing to review. */
export class NoChangesError extends Error {
  constructor(
    readonly base: string,
    readonly withUncommitted = false,
  ) {
    super(
      `No changes between ${base} and HEAD${withUncommitted ? " plus uncommitted changes" : ""}.`,
    );
    this.name = "NoChangesError";
  }
}

/** What `confirmSpend` is shown. */
export interface Preflight {
  trust: Trust;
  diff: DiffStats;
  /** null without past runs to base it on. */
  estimate: CostEstimate | null;
}

/** The user declined to spend on the review; nothing ran. */
export class DeclinedError extends Error {
  constructor() {
    super("Review declined; no agents ran.");
    this.name = "DeclinedError";
  }
}

/** collect → (summarize ‖ review → normalize → verify → rank) → report. */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const { base, trust, harness, models, runAgent, log, runRoot, pr } = options;
  const verbose = options.verbose ?? false;
  const summarize = options.summarize ?? true;
  const find = options.find ?? true;
  const roughEdges = (options.roughEdges ?? true) && find;
  const startedAt = new Date();
  const repo = await resolveRepoRoot(options.cwd);
  const baseSha = await resolveCommit(repo, base);
  const headSha = await resolveCommit(repo, "HEAD");
  const snapshot = options.committedOnly ? null : await snapshotWorkingTree(repo);
  const head = snapshot === null ? { sha: headSha } : { sha: headSha, snapshotSha: snapshot.sha };
  const change = changeRangeOf(base, { pr, uncommitted: snapshot !== null });

  const diff = await diffAgainstBase(repo, base, snapshot?.sha);
  if (diff.trim() === "") {
    throw new NoChangesError(base, snapshot !== null);
  }
  const stats = diffStats(diff);
  const stateRepo = options.stateRepo ?? repo;
  if (trust.level === "external" && options.confirmSpend !== undefined) {
    const estimate = estimateCost(await readIndex(stateRepo), harness, stats, find);
    if (!(await options.confirmSpend({ trust, diff: stats, estimate }))) throw new DeclinedError();
  }
  const setup: [string, string][] = [
    ["Trust", `${trust.level} (${trust.reason})`],
    ["Harness", harness],
  ];
  if (verbose) {
    setup.push(
      ["Repo", repo],
      ["Base", `${base} (${baseSha.slice(0, 7)})`],
      [
        "Head",
        headSha.slice(0, 7) +
          (snapshot === null ? "" : ` + uncommitted (snapshot ${snapshot.sha.slice(0, 7)})`),
      ],
      [
        "Diff",
        `${stats.files} file(s), +${stats.additions} −${stats.deletions}, ${diff.length} chars`,
      ],
    );
  }
  if (snapshot !== null) setup.push(["Uncommitted", `${snapshot.files} file(s) included`]);
  if (summarize) setup.push(["Summarizer", describeModel(models.summarizer)]);
  if (find) {
    setup.push(["Reviewer", describeModel(models.reviewer)]);
    setup.push(["Verifier", describeModel(models.verifier)]);
  }
  const intent: Intent =
    pr !== undefined
      ? {
          kind: "pr",
          number: pr.number,
          title: pr.title,
          body: options.prBody ?? "",
        }
      : {
          kind: "commits",
          messages: await commitMessages(repo, base),
          uncommitted: snapshot !== null,
        };

  if (runRoot === undefined) await ensureStateDir(stateRepo);
  // Taken after .review-flow/ exists; agents must leave the tree exactly like this.
  const status = await snapshotStatus(repo);

  const runDir =
    runRoot === undefined
      ? await createRunDir(stateRepo, await shortSha(repo, "HEAD"), startedAt)
      : await createRunDirAt(runRoot);
  await writeFile(runDir.diffPath, diff);
  await writeJson(runDir.intentPath, intent);
  const record = {
    harness,
    models,
    base: { ref: base, sha: baseSha },
    head,
    ...(pr === undefined ? {} : { pr }),
    trust,
    checkout: repo,
    summarize,
    find,
    roughEdges,
    startedAt: startedAt.toISOString(),
  };
  // So `ask` can find the run, and read the diff and summary, while it goes on.
  await writeJson(runDir.runJsonPath, {
    ...record,
    pid: process.pid,
    finishedAt: null,
    status: "running",
    error: null,
    steps: {},
    totals: EMPTY_TOTALS,
  } satisfies RunRecord);
  setup.push(["Checkout", repo], ["Run dir", runDir.root]);
  if (options.askCommand !== undefined) {
    setup.push([
      "Ask",
      options.askCommand(path.basename(runDir.root), {
        harness,
        model: models.verifier.model,
      }),
    ]);
  }
  const logTable =
    options.logTable ??
    ((_: string, rows: readonly (readonly [string, string])[]) => {
      for (const [label, value] of rows) log(`${label}: ${value}`);
    });
  logTable("Review", setup);

  const stepDurations: StepDurations = new Map([["collect", Date.now() - startedAt.getTime()]]);
  const calls: CallRecord[] = [];
  const abort = new AbortController();
  const ctx: PipelineContext = {
    runDir,
    repo,
    status,
    harness,
    calls,
    runAgent,
    log,
    warn: options.warn ?? log,
    onSummary: options.onSummary ?? (() => log("Summary written")),
    trust: trust.level,
    onActivity:
      options.onActivity ?? ((a) => log(`  [${a.taskId} ${formatElapsed(a.elapsedMs)}] ${a.text}`)),
    verbose,
    signal: abort.signal,
  };
  let failure: string | null = null;
  // Outside the try, so a failed run still indexes what it got to.
  let findingCount: number | null = null;
  let verdictCounts: VerdictCounts | null = null;

  try {
    const sharedContext = buildChangeContext(await loadPrompt("change"), change, diff);
    // The first error thrown by either branch, which stops the other.
    const errors: unknown[] = [];
    const branch = <T>(fn: () => Promise<T>): Promise<T> =>
      fn().catch((error: unknown) => {
        errors.push(error);
        abort.abort(error);
        throw error;
      });

    const summaryBranch = summarize
      ? branch(() =>
          timeStep(stepDurations, "summarize", () =>
            summarizeChange({ change, sharedContext, intent, models }, ctx),
          ),
        )
      : Promise.resolve(null);

    const findBranch = find
      ? branch(async () => {
          const reviewed = await timeStep(stepDurations, "review", async () => {
            const prompt = renderPrompt(await loadPrompt("reviewer"), {
              ...change,
              diffBlock: codeFence(diff, "diff"),
              roughEdges: roughEdges ? await loadPrompt("rough-edges") : "",
            });
            log("Reviewing…");
            const lenient = roughEdges ? lenientReviewOutput() : null;
            const review = await runTask<FindingsOutput | ReviewOutput>(
              {
                taskId: "reviewer",
                role: "reviewer",
                prompt,
                sharedContext: null,
                cwd: repo,
                schema: lenient?.schema ?? FindingsOutput,
                model: models.reviewer.model,
                effort: models.reviewer.effort,
                timeoutMs: REVIEWER_TIMEOUT_MS,
                signal: abort.signal,
              },
              "review",
              ctx,
            );
            if (review.output === null) {
              throw new Error(`Reviewer failed (${review.status}): ${review.error ?? "no output"}`);
            }

            for (const note of lenient?.notes() ?? []) log(note);
            const normalized = normalizeFindings(review.output, repo);
            for (const note of normalized.notes) log(note);
            await writeJson(runDir.findingsPath, normalized.findings);
            log(`Reviewer returned ${normalized.findings.length} finding(s)`);
            // Present exactly when rough edges are on: the schema above asks for them.
            const edges =
              "roughEdges" in review.output
                ? normalizeRoughEdges(review.output.roughEdges, repo)
                : null;
            for (const note of edges?.notes ?? []) log(note);
            if (edges !== null) log(`Reviewer returned ${edges.roughEdges.length} rough edge(s)`);
            return { findings: normalized.findings, edges: edges?.roughEdges ?? null };
          });
          const { findings, edges } = reviewed;

          findingCount = findings.length;
          abort.signal.throwIfAborted();

          const { verdicts, roughEdges: checked } = await verifyAll(
            findings,
            edges,
            { change, sharedContext, models },
            stepDurations,
            ctx,
          );
          verdictCounts = countVerdicts(verdicts);
          return { findings, verdicts, roughEdges: checked };
        })
      : Promise.resolve(null);

    // Both settle before run.json is written, so it records every call.
    const [summaryResult, findResult] = await Promise.allSettled([summaryBranch, findBranch]);
    if (errors.length > 0) throw errors[0];
    const summary = (summaryResult as PromiseFulfilledResult<SummaryOutcome | null>).value;
    const found = (
      findResult as PromiseFulfilledResult<{
        findings: NormalizedFinding[];
        verdicts: Record<string, Verdict>;
        roughEdges: CheckedRoughEdge[];
      } | null>
    ).value;
    if (!find && summary?.status === "failed") {
      throw new Error(`Summarizer failed (${summary.error})`);
    }
    const findings = found?.findings ?? [];
    const verdicts = found?.verdicts ?? {};
    const edges = found?.roughEdges ?? [];

    const durationMs = Date.now() - startedAt.getTime();
    const { costUsd } = rollUp(calls, stepDurations, durationMs).totals;
    await timeStep(stepDurations, "report", async () => {
      const report = renderReport({
        harness,
        models,
        base: { ref: base, sha: baseSha },
        head,
        ...(pr === undefined ? {} : { pr }),
        trust: trust.level,
        durationMs,
        costUsd,
        summary,
        findings: found === null ? null : findings,
        verdicts,
        roughEdges: edges,
      });
      await writeFile(runDir.reportPath, report);
    });
    const saved: [string, string][] = [];
    if (summary?.status === "ok") saved.push(["Summary", runDir.summaryPath]);
    if (found !== null) {
      saved.push(["Findings", runDir.findingsPath], ["Verdicts", runDir.verdictsPath]);
      if (roughEdges) saved.push(["Rough edges", runDir.roughEdgesPath]);
    }
    saved.push(["Report", runDir.reportPath]);
    if (verbose) {
      saved.push([
        "Steps",
        [...stepDurations].map(([step, ms]) => `${step} ${formatDuration(ms)}`).join(" · "),
      ]);
    }
    logTable("Saved", saved);

    return {
      runDir,
      checkout: repo,
      summary,
      findings,
      verdicts,
      roughEdges: edges,
      costUsd,
      durationMs,
    };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const finishedAt = new Date();
    const outcome = failure === null ? "ok" : "failed";
    const run: RunRecord = {
      ...record,
      finishedAt: finishedAt.toISOString(),
      status: outcome,
      error: failure,
      ...rollUp(calls, stepDurations, finishedAt.getTime() - startedAt.getTime()),
    };
    await writeJson(runDir.runJsonPath, run);
    if (runRoot === undefined) {
      await appendIndexEntry(stateRepo, {
        id: path.basename(runDir.root),
        kind: "review",
        startedAt: run.startedAt,
        durationMs: run.totals.durationMs,
        status: outcome,
        harness,
        models,
        base: run.base,
        head: run.head,
        ...(pr === undefined ? {} : { pr: pr.number }),
        diff: stats,
        findings: findingCount,
        verdicts: verdictCounts,
        costUsd: run.totals.costUsd,
        unknownCostCalls: run.totals.unknownCostCalls,
      });
    }
  }
}
