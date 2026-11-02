import { appendFile, writeFile } from "node:fs/promises";
import type { AgentResult, AgentTask, RunAgent, TokenUsage } from "./agent.ts";
import type { CallRecord, Step } from "./calls.ts";
import { assertStatusUnchanged, type StatusSnapshot } from "./git.ts";
import { formatDuration } from "./format.ts";
import { writeJson } from "./json.ts";
import type { Harness } from "./models.ts";
import { computeCostUsd } from "./prices.ts";
import type { RunDir } from "./run-dir.ts";

export interface TaskActivity {
  taskId: string;
  /** Since the task started. */
  elapsedMs: number;
  /** A tool call or heartbeat; on the last event, the outcome, such as `done: ok, $0.06`. */
  text: string;
  /** The task has ended. */
  done: boolean;
}

/** What `runTask` needs: where records go, and the checkout agents must leave unchanged. */
export interface TaskContext {
  runDir: RunDir;
  /** The checkout agents work in. */
  repo: string;
  status: StatusSnapshot;
  harness: Harness;
  calls: CallRecord[];
  runAgent: RunAgent;
  log: (message: string) => void;
  onActivity: (activity: TaskActivity) => void;
  verbose: boolean;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const QUIET_THRESHOLD_MS = 30_000;

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `in 1,200 · cache read 30,000 · cache write 0 · out 800`. */
function describeUsage(usage: TokenUsage | null): string {
  if (usage === null) return "tokens: not reported";
  const n = (count: number) => count.toLocaleString("en-US");
  return `tokens: in ${n(usage.input)} · cache read ${n(usage.cacheRead)} · cache write ${n(usage.cacheWrite)} · out ${n(usage.output)}`;
}

/**
 * Runs one agent task with the run's bookkeeping: prompt + raw output on disk, a line in
 * calls.jsonl, progress lines (each tool call, plus a heartbeat when the agent is quiet), tree
 * check after.
 */
export async function runTask<T>(
  task: Omit<AgentTask<T>, "onProgress" | "onDetail">,
  step: Step,
  ctx: TaskContext,
  onActivity?: () => void,
): Promise<AgentResult<T> & { call: CallRecord }> {
  await writeFile(ctx.runDir.promptPath(task.taskId), task.prompt);

  const startedAt = Date.now();
  let lastActivity = startedAt;
  const line = (text: string) =>
    ctx.log(`  [${task.taskId} ${formatElapsed(Date.now() - startedAt)}] ${text}`);
  const activity = (text: string, done = false) =>
    ctx.onActivity({ taskId: task.taskId, elapsedMs: Date.now() - startedAt, text, done });
  const heartbeat = setInterval(() => {
    const quietFor = Date.now() - lastActivity;
    if (quietFor >= QUIET_THRESHOLD_MS) {
      activity(`still working (no tool calls for ${Math.round(quietFor / 1000)}s)`);
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (ctx.verbose) {
    const shared =
      task.sharedContext === null ? "" : `, shared context ${task.sharedContext.length} chars`;
    line(`prompt: ${task.prompt.length} chars${shared} → ${ctx.runDir.promptPath(task.taskId)}`);
  }

  let result: AgentResult<T>;
  try {
    result = await ctx.runAgent({
      ...task,
      onProgress: ({ tool, detail }) => {
        lastActivity = Date.now();
        activity(detail === null ? tool : `${tool} ${detail}`);
        onActivity?.();
      },
      ...(ctx.verbose ? { onDetail: line } : {}),
    });
  } catch (error) {
    activity("failed", true);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
  const computedCost = result.costUsd === null ? computeCostUsd(task.model, result.usage) : null;
  const costUsd = result.costUsd ?? computedCost;
  activity(`done: ${result.status}${costUsd === null ? "" : `, $${costUsd.toFixed(2)}`}`, true);
  if (ctx.verbose) {
    if (result.error !== null) line(`error: ${result.error}`);
    line(
      `${describeUsage(result.usage)} · ${formatDuration(result.durationMs)} · cost ${result.costUsd !== null ? "reported" : computedCost !== null ? "computed" : "unknown"}`,
    );
  }

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
  return { ...result, call };
}
