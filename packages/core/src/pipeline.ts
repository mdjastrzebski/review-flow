import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { AgentResult, AgentStatus, AgentTask, RunAgent } from "./agent.ts";
import { rollUp, type CallRecord, type Step, type TimedTotals } from "./calls.ts";
import {
  assertStatusUnchanged,
  diffAgainstBase,
  resolveCommit,
  resolveRepoRoot,
  shortSha,
  snapshotStatus,
  snapshotWorkingTree,
  type StatusSnapshot,
} from "./git.ts";
import { describeModel } from "./format.ts";
import { writeJson } from "./json.ts";
import type { Harness, RoleModels } from "./models.ts";
import { normalizeFindings } from "./normalize.ts";
import { computeCostUsd } from "./prices.ts";
import { codeFence, loadPrompt, renderPrompt } from "./prompts.ts";
import { createRunDir, createRunDirAt, ensureGitignored, type RunDir } from "./run-dir.ts";
import { appendIndexEntry, countVerdicts, diffStats, type VerdictCounts } from "./run-index.ts";
import { applyVerdictRules } from "./rank.ts";
import { renderReport } from "./report.ts";
import { ReviewOutput, Verdict, type NormalizedFinding } from "./schemas.ts";
import {
  buildChangeContext,
  buildVerifierPrompt,
  verifierTaskId,
  type ChangeRange,
} from "./verify.ts";

const REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;
const VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFIER_CONCURRENCY = 3;

export interface ReviewRunOptions {
  /** Any directory inside the repository to review. */
  cwd: string;
  base: string;
  harness: Harness;
  models: RoleModels;
  runAgent: RunAgent;
  log: (message: string) => void;
  /** Review HEAD only; by default uncommitted changes are reviewed too, through a snapshot. */
  committedOnly?: boolean;
  /**
   * Where to create the run dir (an eval case). By default it goes in the repo's
   * `.review-flow/runs/` and is indexed; with a path, the repo's .gitignore and index are left alone.
   */
  runRoot?: string;
}

export interface ReviewRunResult {
  runDir: RunDir;
  findings: NormalizedFinding[];
  /** findingId → verdict, with the code-enforced rules applied. */
  verdicts: Record<string, Verdict>;
  /** null when no call has a reported or computed cost. */
  costUsd: number | null;
  durationMs: number;
}

/** run.json. Per-call detail is in calls.jsonl. */
export interface RunRecord {
  harness: Harness;
  models: RoleModels;
  base: { ref: string; sha: string };
  /** snapshotSha: the commit holding uncommitted changes that was reviewed instead of HEAD. */
  head: { sha: string; snapshotSha?: string };
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  error: string | null;
  steps: Partial<Record<Step, TimedTotals>>;
  totals: TimedTotals;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const QUIET_THRESHOLD_MS = 30_000;

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface TaskContext {
  runDir: RunDir;
  repo: string;
  status: StatusSnapshot;
  harness: Harness;
  calls: CallRecord[];
  runAgent: RunAgent;
  log: (message: string) => void;
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
 * Runs one agent task with the run's bookkeeping: prompt + raw output on disk, a line in
 * calls.jsonl, progress lines (each tool call, plus a heartbeat when the agent is quiet), tree
 * check after.
 */
async function runTask<T>(
  task: Omit<AgentTask<T>, "onProgress">,
  step: Step,
  ctx: TaskContext,
  onActivity?: () => void,
): Promise<AgentResult<T>> {
  await writeFile(ctx.runDir.promptPath(task.taskId), task.prompt);

  const startedAt = Date.now();
  let lastActivity = startedAt;
  const line = (text: string) =>
    ctx.log(`  [${task.taskId} ${formatElapsed(Date.now() - startedAt)}] ${text}`);
  const heartbeat = setInterval(() => {
    const quietFor = Date.now() - lastActivity;
    if (quietFor >= QUIET_THRESHOLD_MS) {
      line(`still working (no tool calls for ${Math.round(quietFor / 1000)}s)`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  let result: AgentResult<T>;
  try {
    result = await ctx.runAgent({
      ...task,
      onProgress: ({ tool, detail }) => {
        lastActivity = Date.now();
        line(detail === null ? tool : `${tool} ${detail}`);
        onActivity?.();
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
  const computedCost = result.costUsd === null ? computeCostUsd(task.model, result.usage) : null;
  const costUsd = result.costUsd ?? computedCost;
  line(`done: ${result.status}${costUsd === null ? "" : `, $${costUsd.toFixed(2)}`}`);

  await writeJson(ctx.runDir.rawPath(task.taskId), result.raw);
  const call: CallRecord = {
    taskId: task.taskId,
    role: task.role,
    step,
    harness: ctx.harness,
    model: task.model,
    effort: task.effort,
    status: result.status,
    error: result.error,
    usage: result.usage,
    costUsd,
    costSource:
      result.costUsd !== null ? "reported" : computedCost !== null ? "computed" : "unknown",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: result.durationMs,
    outsideReads: result.outsideReads ?? [],
  };
  ctx.calls.push(call);
  // Appended as each call ends, so a crashed run still keeps its records.
  await appendFile(ctx.runDir.callsPath, `${JSON.stringify(call)}\n`);
  // Agents are read-only by configuration; this is the safety net if that ever fails.
  await assertStatusUnchanged(ctx.repo, ctx.status);
  return result;
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
  context: { change: ChangeRange; diff: string; models: RoleModels },
  ctx: TaskContext,
): Promise<Record<string, Verdict>> {
  const template = await loadPrompt("verifier");
  const sharedContext = buildChangeContext(
    await loadPrompt("change"),
    context.change,
    context.diff,
  );
  const warm = Promise.withResolvers<void>();
  // rejectOnClear: otherwise cleared tasks never settle and allSettled hangs.
  const limit = pLimit({ concurrency: VERIFIER_CONCURRENCY, rejectOnClear: true });
  const abort = new AbortController();
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
            ctx.log(`${finding.id}: verifier failed (${result.status}); marked inconclusive.`);
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

/** collect → review → normalize → verify → rank → report. */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const { base, harness, models, runAgent, log, runRoot } = options;
  const startedAt = new Date();
  const repo = await resolveRepoRoot(options.cwd);
  const baseSha = await resolveCommit(repo, base);
  const headSha = await resolveCommit(repo, "HEAD");
  const snapshot = options.committedOnly ? null : await snapshotWorkingTree(repo);
  const head = snapshot === null ? { sha: headSha } : { sha: headSha, snapshotSha: snapshot.sha };
  const change: ChangeRange = {
    base,
    head: snapshot === null ? "`HEAD`" : "`HEAD` plus uncommitted changes",
  };

  const diff = await diffAgainstBase(repo, base, snapshot?.sha);
  if (diff.trim() === "") {
    throw new NoChangesError(base, snapshot !== null);
  }
  if (snapshot !== null) log(`Including ${snapshot.files} uncommitted file(s)`);
  log(`Reviewer: ${describeModel(models.reviewer)}`);
  log(`Verifier: ${describeModel(models.verifier)}`);

  if (runRoot === undefined && (await ensureGitignored(repo))) {
    log("Added .review-flow/ to .gitignore");
  }
  // Taken after the .gitignore edit; agents must leave the tree exactly like this.
  const status = await snapshotStatus(repo);

  const runDir =
    runRoot === undefined
      ? await createRunDir(repo, await shortSha(repo, "HEAD"), startedAt)
      : await createRunDirAt(runRoot);
  await writeFile(runDir.diffPath, diff);
  log(`Run dir: ${runDir.root}`);

  const stepDurations: StepDurations = new Map([["collect", Date.now() - startedAt.getTime()]]);
  const calls: CallRecord[] = [];
  const ctx: TaskContext = { runDir, repo, status, harness, calls, runAgent, log };
  let failure: string | null = null;
  // Outside the try, so a failed run still indexes what it got to.
  let findingCount: number | null = null;
  let verdictCounts: VerdictCounts | null = null;

  try {
    const findings = await timeStep(stepDurations, "review", async () => {
      const prompt = renderPrompt(await loadPrompt("reviewer"), {
        ...change,
        diffBlock: codeFence(diff, "diff"),
      });
      log(`Reviewing with ${models.reviewer.model ?? "harness default model"}…`);
      const review = await runTask(
        {
          taskId: "reviewer",
          role: "reviewer",
          prompt,
          sharedContext: null,
          cwd: repo,
          schema: ReviewOutput,
          model: models.reviewer.model,
          effort: models.reviewer.effort,
          timeoutMs: REVIEWER_TIMEOUT_MS,
        },
        "review",
        ctx,
      );
      if (review.output === null) {
        throw new Error(`Reviewer failed (${review.status}): ${review.error ?? "no output"}`);
      }

      const normalized = normalizeFindings(review.output, repo);
      for (const note of normalized.notes) log(note);
      await writeJson(runDir.findingsPath, normalized.findings);
      log(`Reviewer returned ${normalized.findings.length} finding(s) → ${runDir.findingsPath}`);
      return normalized.findings;
    });

    findingCount = findings.length;

    const verdicts = await timeStep(stepDurations, "verify", async () => {
      if (findings.length > 0) {
        log(
          `Verifying ${findings.length} finding(s) with ${models.verifier.model ?? "harness default model"}…`,
        );
      }
      const result = await verifyFindings(findings, { change, diff, models }, ctx);
      await writeJson(runDir.verdictsPath, result);
      log(`Verdicts → ${runDir.verdictsPath}`);
      return result;
    });

    verdictCounts = countVerdicts(verdicts);

    const durationMs = Date.now() - startedAt.getTime();
    const { costUsd } = rollUp(calls, stepDurations, durationMs).totals;
    await timeStep(stepDurations, "report", async () => {
      const report = renderReport({
        harness,
        models,
        base: { ref: base, sha: baseSha },
        head,
        durationMs,
        costUsd,
        findings,
        verdicts,
      });
      await writeFile(runDir.reportPath, report);
      log(`Report → ${runDir.reportPath}`);
    });

    return { runDir, findings, verdicts, costUsd, durationMs };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const finishedAt = new Date();
    const run: RunRecord = {
      harness,
      models,
      base: { ref: base, sha: baseSha },
      head,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: failure === null ? "ok" : "failed",
      error: failure,
      ...rollUp(calls, stepDurations, finishedAt.getTime() - startedAt.getTime()),
    };
    await writeJson(runDir.runJsonPath, run);
    if (runRoot === undefined) {
      await appendIndexEntry(repo, {
        id: path.basename(runDir.root),
        kind: "review",
        startedAt: run.startedAt,
        durationMs: run.totals.durationMs,
        status: run.status,
        harness,
        models,
        base: run.base,
        head: run.head,
        diff: diffStats(diff),
        findings: findingCount,
        verdicts: verdictCounts,
        costUsd: run.totals.costUsd,
        unknownCostCalls: run.totals.unknownCostCalls,
      });
    }
  }
}
