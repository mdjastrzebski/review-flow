import { writeFile } from "node:fs/promises";
import pLimit from "p-limit";
import type { AgentResult, AgentStatus, AgentTask, RunAgent, TokenUsage } from "./agent.ts";
import {
  assertStatusUnchanged,
  diffAgainstBase,
  resolveCommit,
  resolveRepoRoot,
  shortSha,
  snapshotStatus,
  type StatusSnapshot,
} from "./git.ts";
import { describeModel } from "./format.ts";
import type { Harness, Role, RoleModels } from "./models.ts";
import { normalizeFindings } from "./normalize.ts";
import { codeFence, loadPrompt, renderPrompt } from "./prompts.ts";
import { createRunDir, ensureGitignored, type RunDir } from "./run-dir.ts";
import { applyVerdictRules } from "./rank.ts";
import { renderReport } from "./report.ts";
import { ReviewOutput, Verdict, type NormalizedFinding } from "./schemas.ts";
import { buildVerifierPrompt, verifierTaskId } from "./verify.ts";

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
}

export interface ReviewRunResult {
  runDir: RunDir;
  findings: NormalizedFinding[];
  /** findingId → verdict, with the code-enforced rules applied. */
  verdicts: Record<string, Verdict>;
  /** null when no task reported a cost (Cursor). */
  costUsd: number | null;
  durationMs: number;
}

interface TaskRecord {
  taskId: string;
  role: Role;
  status: AgentStatus;
  error: string | null;
  costUsd: number | null;
  usage: TokenUsage | null;
  durationMs: number;
}

interface RunRecord {
  harness: Harness;
  models: RoleModels;
  base: { ref: string; sha: string };
  head: { sha: string };
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Sum over tasks that reported a cost; null when none did. */
  costUsd: number | null;
  status: "running" | "ok" | "failed";
  error: string | null;
  tasks: TaskRecord[];
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
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
  run: RunRecord;
  runAgent: RunAgent;
  log: (message: string) => void;
}

/**
 * Runs one agent task with the run's bookkeeping: prompt + raw output on disk, progress lines
 * (each tool call, plus a heartbeat when the agent is quiet), tree check after.
 */
async function runTask<T>(
  task: Omit<AgentTask<T>, "onProgress">,
  ctx: TaskContext,
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
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
  line(`done: ${result.status}${result.costUsd === null ? "" : `, $${result.costUsd.toFixed(2)}`}`);

  await writeJson(ctx.runDir.rawPath(task.taskId), result.raw);
  ctx.run.tasks.push({
    taskId: task.taskId,
    role: task.role,
    status: result.status,
    error: result.error,
    costUsd: result.costUsd,
    usage: result.usage,
    durationMs: result.durationMs,
  });
  if (result.costUsd !== null) ctx.run.costUsd = (ctx.run.costUsd ?? 0) + result.costUsd;
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
 */
async function verifyFindings(
  findings: readonly NormalizedFinding[],
  context: { base: string; diff: string; models: RoleModels },
  ctx: TaskContext,
): Promise<Record<string, Verdict>> {
  const template = await loadPrompt("verifier");
  // rejectOnClear: otherwise cleared tasks never settle and allSettled hangs.
  const limit = pLimit({ concurrency: VERIFIER_CONCURRENCY, rejectOnClear: true });
  const abort = new AbortController();
  // The first thrown error, in the order thrown; cleared tasks reject later with AbortErrors.
  const errors: unknown[] = [];
  const settled = await Promise.allSettled(
    findings.map((finding) =>
      limit(async (): Promise<[string, Verdict]> => {
        try {
          const result = await runTask(
            {
              taskId: verifierTaskId(finding),
              role: "verifier",
              prompt: buildVerifierPrompt(template, finding, context),
              cwd: ctx.repo,
              schema: Verdict,
              model: context.models.verifier.model,
              effort: context.models.verifier.effort,
              timeoutMs: VERIFIER_TIMEOUT_MS,
              signal: abort.signal,
            },
            ctx,
          );
          if (result.output === null) {
            ctx.log(`${finding.id}: verifier failed (${result.status}); marked inconclusive.`);
            return [finding.id, failedVerdict(finding, result.status, result.error)];
          }
          return [finding.id, applyVerdictRules(result.output)];
        } catch (error) {
          errors.push(error);
          limit.clearQueue();
          abort.abort();
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
  constructor(readonly base: string) {
    super(`No changes between ${base} and HEAD.`);
    this.name = "NoChangesError";
  }
}

/** collect → review → normalize → verify → rank → report. */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const { base, harness, models, runAgent, log } = options;
  const repo = await resolveRepoRoot(options.cwd);
  const baseSha = await resolveCommit(repo, base);
  const headSha = await resolveCommit(repo, "HEAD");

  const diff = await diffAgainstBase(repo, base);
  if (diff.trim() === "") {
    throw new NoChangesError(base);
  }
  log(`Reviewer: ${describeModel(models.reviewer)}`);
  log(`Verifier: ${describeModel(models.verifier)}`);

  if (await ensureGitignored(repo)) {
    log("Added .review-flow/ to .gitignore");
  }
  // Taken after the .gitignore edit; agents must leave the tree exactly like this.
  const status = await snapshotStatus(repo);

  const startedAt = new Date();
  const runDir = await createRunDir(repo, await shortSha(repo, "HEAD"), startedAt);
  await writeFile(runDir.diffPath, diff);
  log(`Run dir: ${runDir.root}`);

  const run: RunRecord = {
    harness,
    models,
    base: { ref: base, sha: baseSha },
    head: { sha: headSha },
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    costUsd: null,
    status: "running",
    error: null,
    tasks: [],
  };
  const ctx: TaskContext = { runDir, repo, status, run, runAgent, log };

  try {
    const prompt = renderPrompt(await loadPrompt("reviewer"), {
      base,
      diffBlock: codeFence(diff, "diff"),
    });
    log(`Reviewing with ${models.reviewer.model ?? "harness default model"}…`);
    const review = await runTask(
      {
        taskId: "reviewer",
        role: "reviewer",
        prompt,
        cwd: repo,
        schema: ReviewOutput,
        model: models.reviewer.model,
        effort: models.reviewer.effort,
        timeoutMs: REVIEWER_TIMEOUT_MS,
      },
      ctx,
    );
    if (review.output === null) {
      throw new Error(`Reviewer failed (${review.status}): ${review.error ?? "no output"}`);
    }

    const { findings, notes } = normalizeFindings(review.output, repo);
    for (const note of notes) log(note);
    await writeJson(runDir.findingsPath, findings);
    log(`Reviewer returned ${findings.length} finding(s) → ${runDir.findingsPath}`);

    if (findings.length > 0) {
      log(
        `Verifying ${findings.length} finding(s) with ${models.verifier.model ?? "harness default model"}…`,
      );
    }
    const verdicts = await verifyFindings(findings, { base, diff, models }, ctx);
    await writeJson(runDir.verdictsPath, verdicts);
    log(`Verdicts → ${runDir.verdictsPath}`);

    const durationMs = Date.now() - startedAt.getTime();
    const report = renderReport({
      harness,
      models,
      base: run.base,
      head: run.head,
      durationMs,
      costUsd: run.costUsd,
      findings,
      verdicts,
    });
    await writeFile(runDir.reportPath, report);
    log(`Report → ${runDir.reportPath}`);

    run.status = "ok";
    return { runDir, findings, verdicts, costUsd: run.costUsd, durationMs };
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const finishedAt = new Date();
    run.finishedAt = finishedAt.toISOString();
    run.durationMs = finishedAt.getTime() - startedAt.getTime();
    await writeJson(runDir.runJsonPath, run);
  }
}
