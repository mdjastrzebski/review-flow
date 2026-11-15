import { appendFile, writeFile } from "node:fs/promises";
import type { AgentCallTask, AgentResult, RunAgent, TokenUsage } from "./agent.ts";
import { formatDuration, formatElapsed } from "./format.ts";
import { writeJson } from "./json.ts";
import { computeCostUsd } from "./prices.ts";
import { callStatus, type CallRecord } from "./records.ts";
import type { RunDirBase } from "./run-dir.ts";

export interface TaskActivity {
  taskId: string;
  /** Since the task started. */
  elapsedMs: number;
  /** A tool call or heartbeat; on the last event, the outcome, such as `done: ok, $0.06`. */
  text: string;
  /** The task has ended. */
  done: boolean;
}

/** What `runAgentCall` needs: where records go, and how to report progress. */
export interface CallScope {
  runDir: RunDirBase;
  /** Recorded on the call, e.g. `review/find`. */
  path: string;
  harness: string;
  runAgent: RunAgent;
  log: (message: string) => void;
  onActivity: (activity: TaskActivity) => void;
  verbose: boolean;
  /** Each finished call, before `afterCall`. */
  onCall?: (call: CallRecord) => void;
  /** Runs after the call is recorded; a throw fails the call (e.g. the checkout changed). */
  afterCall?: (call: CallRecord) => Promise<void>;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const QUIET_THRESHOLD_MS = 30_000;

/** `in 1,200 · cache read 30,000 · cache write 0 · out 800`. */
function describeUsage(usage: TokenUsage | null): string {
  if (usage === null) return "tokens: not reported";
  const n = (count: number) => count.toLocaleString("en-US");
  return `tokens: in ${n(usage.input)} · cache read ${n(usage.cacheRead)} · cache write ${n(usage.cacheWrite)} · out ${n(usage.output)}`;
}

/**
 * Runs one agent task with the run's bookkeeping: prompt + raw output on disk, a line in
 * calls.jsonl, progress lines (each tool call, plus a heartbeat when the agent is quiet), then
 * `afterCall`. `onProgress` is called on each tool call.
 */
export async function runAgentCall<T>(
  task: AgentCallTask<T>,
  scope: CallScope,
  onProgress?: () => void,
): Promise<AgentResult<T> & { call: CallRecord }> {
  await writeFile(scope.runDir.promptPath(task.taskId), task.prompt);

  const startedAt = Date.now();
  let lastActivity = startedAt;
  const line = (text: string) =>
    scope.log(`  [${task.taskId} ${formatElapsed(Date.now() - startedAt)}] ${text}`);
  const activity = (text: string, done = false) =>
    scope.onActivity({ taskId: task.taskId, elapsedMs: Date.now() - startedAt, text, done });
  const heartbeat = setInterval(() => {
    const quietFor = Date.now() - lastActivity;
    if (quietFor >= QUIET_THRESHOLD_MS) {
      activity(`still working (no tool calls for ${Math.round(quietFor / 1000)}s)`);
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (scope.verbose) {
    const shared =
      task.sharedContext === null ? "" : `, shared context ${task.sharedContext.length} chars`;
    line(`prompt: ${task.prompt.length} chars${shared} → ${scope.runDir.promptPath(task.taskId)}`);
  }

  let result: AgentResult<T>;
  try {
    result = await scope.runAgent({
      ...task,
      onProgress: ({ tool, detail }) => {
        lastActivity = Date.now();
        activity(detail === null ? tool : `${tool} ${detail}`);
        onProgress?.();
      },
      ...(scope.verbose ? { onDetail: line } : {}),
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
  if (scope.verbose) {
    if (result.status === "failure") line(`error: ${result.error}`);
    line(
      `${describeUsage(result.usage)} · ${formatDuration(result.durationMs)} · cost ${result.costUsd !== null ? "reported" : computedCost !== null ? "computed" : "unknown"}`,
    );
  }

  await writeJson(scope.runDir.rawPath(task.taskId), result.raw);
  const call: CallRecord = {
    taskId: task.taskId,
    role: task.role,
    path: scope.path,
    harness: scope.harness,
    model: task.model,
    effort: task.effort,
    ...callStatus(result),
    usage: result.usage,
    costUsd,
    costSource:
      result.costUsd !== null ? "reported" : computedCost !== null ? "computed" : "unknown",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: result.durationMs,
    outsideReads: result.outsideReads ?? [],
  };
  scope.onCall?.(call);
  // Appended as each call ends, so a crashed run still keeps its records.
  await appendFile(scope.runDir.callsPath, `${JSON.stringify(call)}\n`);
  await scope.afterCall?.(call);
  return { ...result, call };
}
