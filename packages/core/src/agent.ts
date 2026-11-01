import type { z } from "zod";
import type { Effort, Role } from "./models.ts";

/** The only harness-specific seam: each harness implements RunAgent. */
export interface AgentTask<T> {
  taskId: string;
  role: Role;
  prompt: string;
  cwd: string;
  /** Validates the agent's final answer; adapters also derive the JSON Schema from it. */
  schema: z.ZodType<T>;
  model: string | null;
  effort: Effort | null;
  timeoutMs: number;
  /** Aborting stops the session early; the result comes back with status "error". */
  signal?: AbortSignal;
  /** Called as the agent works, so long-running tasks visibly make progress. */
  onProgress: (event: AgentProgress) => void;
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

export type AgentStatus = "ok" | "invalid_output" | "error" | "timeout";

export interface AgentResult<T> {
  status: AgentStatus;
  /** Schema-valid output; null unless status is "ok". */
  output: T | null;
  /** The agent's final text answer, as returned by the harness. */
  rawText: string;
  /** Everything the harness emitted, persisted to raw/<taskId>.json for debugging. */
  raw: unknown;
  /** Why the task did not succeed; null when status is "ok". */
  error: string | null;
  costUsd: number | null;
  /** null when the harness reports no token counts. */
  usage: TokenUsage | null;
  durationMs: number;
}

export type RunAgent = <T>(task: AgentTask<T>) => Promise<AgentResult<T>>;
