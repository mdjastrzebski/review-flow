import { writeFile } from "node:fs/promises";
import type { AgentResult, AgentStatus, AgentTask, RunAgent } from "./agent.ts";
import {
  assertStatusUnchanged,
  diffAgainstBase,
  resolveCommit,
  resolveRepoRoot,
  shortSha,
  snapshotStatus,
  type StatusSnapshot,
} from "./git.ts";
import type { Harness, Role, RoleModels } from "./models.ts";
import { normalizeFindings } from "./normalize.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { createRunDir, ensureGitignored, type RunDir } from "./run-dir.ts";
import { ReviewOutput, type NormalizedFinding } from "./schemas.ts";

const REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;

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
  costUsd: number;
  durationMs: number;
}

interface TaskRecord {
  taskId: string;
  role: Role;
  status: AgentStatus;
  error: string | null;
  costUsd: number | null;
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
  costUsd: number;
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
    durationMs: result.durationMs,
  });
  ctx.run.costUsd += result.costUsd ?? 0;
  // Agents are read-only by configuration; this is the safety net if that ever fails.
  await assertStatusUnchanged(ctx.repo, ctx.status);
  return result;
}

/** collect → review → normalize. Verification, ranking and the report come in later steps. */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const { base, harness, models, runAgent, log } = options;
  const repo = await resolveRepoRoot(options.cwd);
  const baseSha = await resolveCommit(repo, base);
  const headSha = await resolveCommit(repo, "HEAD");

  const diff = await diffAgainstBase(repo, base);
  if (diff.trim() === "") {
    throw new Error(`No changes between ${base} and HEAD.`);
  }

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
    costUsd: 0,
    status: "running",
    error: null,
    tasks: [],
  };
  const ctx: TaskContext = { runDir, repo, status, run, runAgent, log };

  try {
    const prompt = renderPrompt(await loadPrompt("reviewer"), { base, diff });
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

    run.status = "ok";
    return {
      runDir,
      findings,
      costUsd: run.costUsd,
      durationMs: Date.now() - startedAt.getTime(),
    };
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
