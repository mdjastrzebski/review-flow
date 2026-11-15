import type { z } from "zod";

/** The only harness-specific seam: each harness implements RunAgent. */
export interface AgentTask<T> {
  taskId: string;
  /** What the call is for, such as `reviewer`; the domain layer names its roles. */
  role: string;
  prompt: string;
  /**
   * Text that is identical across a run's tasks of one role, such as the diff. A harness that can
   * cache it across sessions sends it apart from the prompt (claude: the system prompt).
   */
  sharedContext: string | null;
  cwd: string;
  /** Validates the agent's final answer; adapters also derive the JSON Schema from it. */
  schema: z.ZodType<T>;
  model: string | null;
  /** null = the harness or model default. */
  effort: string | null;
  timeoutMs: number;
  /** Aborting stops the session early; the result comes back with status "error". */
  signal?: AbortSignal;
  /** Called as the agent works, so long-running tasks visibly make progress. */
  onProgress: (event: AgentProgress) => void;
  /**
   * Diagnostic lines for `--verbose`: the command run, session details, the agent's text, how the
   * CLI exited. Unlike onProgress, these don't count as activity.
   */
  onDetail?: (text: string) => void;
}

/** A tool call the agent made, e.g. `{ tool: "Read", detail: "src/git.ts" }`. */
export interface AgentProgress {
  tool: string;
  detail: string | null;
}

/** Tokens for one task, summed over all its model requests. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Why a task has no output. */
export type AgentFailureReason = "invalid_output" | "error" | "timeout";

/** How a task ended: schema-valid output, or why there is none. */
export type AgentOutcome<T> =
  | { status: "success"; output: T }
  | { status: "failure"; reason: AgentFailureReason; error: string };

/** What every task reports, whatever its outcome. */
export interface AgentRunInfo {
  /** The agent's final text answer, as returned by the harness. */
  rawText: string;
  /** Everything the harness emitted, persisted to raw/<taskId>.json for debugging. */
  raw: unknown;
  costUsd: number | null;
  /** null when the harness reports no token counts. */
  usage: TokenUsage | null;
  durationMs: number;
  /**
   * Reads outside the repo that ran: a harness that can only check tool calls after they run
   * (cursor) records them instead of stopping the task.
   */
  outsideReads?: string[];
}

export type AgentResult<T> = AgentOutcome<T> & AgentRunInfo;

/** A failure as one line, e.g. `timeout: Timed out after 600000 ms`. */
export function describeFailure(failure: { reason: AgentFailureReason; error: string }): string {
  return `${failure.reason}: ${failure.error}`;
}

export type RunAgent = <T>(task: AgentTask<T>) => Promise<AgentResult<T>>;

/** A task as a flow hands it to the runtime, which adds the progress callbacks. */
export type AgentCallTask<T> = Omit<AgentTask<T>, "onProgress" | "onDetail">;
