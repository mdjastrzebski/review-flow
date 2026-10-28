import path from "node:path";
import {
  query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentResult, AgentTask } from "@review-flow/core";
import { z } from "zod";
import { READ_ONLY_TOOLS, readOnlyGuard, STRUCTURED_OUTPUT_TOOL } from "./guard.ts";

/**
 * The CLI validates `--json-schema` with a validator that doesn't know zod's default
 * draft-2020-12 `$schema` URI, so drop it; the schema itself uses only portable keywords.
 */
function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

function describeToolInput(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  const str = (key: string) => (typeof input[key] === "string" ? input[key] : null);
  const rel = (p: string | null) =>
    p === null ? null : path.relative(cwd, path.resolve(cwd, p)) || ".";
  switch (tool) {
    case "Read":
      return rel(str("file_path"));
    case "Grep":
    case "Glob": {
      const pattern = str("pattern");
      const where = rel(str("path"));
      return where === null ? pattern : `${pattern} in ${where}`;
    }
    case STRUCTURED_OUTPUT_TOOL:
      return "submitting result";
    default:
      return null;
  }
}

function reportToolCalls(message: SDKAssistantMessage, task: AgentTask<unknown>): void {
  for (const block of message.message.content) {
    if (block.type !== "tool_use") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    task.onProgress({ tool: block.name, detail: describeToolInput(block.name, input, task.cwd) });
  }
}

export async function runClaudeAgent<T>(task: AgentTask<T>): Promise<AgentResult<T>> {
  const startedAt = Date.now();
  const messages: SDKMessage[] = [];
  const denied: string[] = [];
  const finish = (fields: Omit<AgentResult<T>, "raw" | "durationMs">): AgentResult<T> => ({
    ...fields,
    raw: { messages, deniedToolCalls: denied },
    durationMs: Date.now() - startedAt,
  });
  const cancelled = () =>
    finish({ status: "error", output: null, rawText: "", error: "Cancelled", costUsd: null });

  // Covers a task dequeued just before its caller aborted.
  if (task.signal?.aborted) return cancelled();

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, task.timeoutMs);
  const onAbort = () => abortController.abort();
  task.signal?.addEventListener("abort", onAbort, { once: true });

  let result: SDKResultMessage | null = null;
  try {
    const session = query({
      prompt: task.prompt,
      options: {
        cwd: task.cwd,
        ...(task.model === null ? {} : { model: task.model }),
        ...(task.effort === null ? {} : { effort: task.effort }),
        tools: READ_ONLY_TOOLS,
        allowedTools: READ_ONLY_TOOLS,
        permissionMode: "dontAsk",
        // Isolation: no user/project settings, hooks, or CLAUDE.md; no session saved for resume.
        settingSources: [],
        persistSession: false,
        outputFormat: { type: "json_schema", schema: toOutputSchema(task.schema) },
        hooks: { PreToolUse: [{ hooks: [readOnlyGuard(task.cwd, denied)] }] },
        abortController,
      },
    });
    for await (const message of session) {
      messages.push(message);
      if (message.type === "assistant") reportToolCalls(message, task);
      if (message.type === "result") result = message;
    }
  } catch (error) {
    if (!timedOut && task.signal?.aborted) return cancelled();
    const message = error instanceof Error ? error.message : String(error);
    return finish({
      status: timedOut ? "timeout" : "error",
      output: null,
      rawText: "",
      error: timedOut ? `Timed out after ${task.timeoutMs} ms` : message,
      costUsd: null,
    });
  } finally {
    clearTimeout(timer);
    task.signal?.removeEventListener("abort", onAbort);
  }

  if (result === null) {
    if (!timedOut && task.signal?.aborted) return cancelled();
    return finish({
      status: timedOut ? "timeout" : "error",
      output: null,
      rawText: "",
      error: timedOut
        ? `Timed out after ${task.timeoutMs} ms`
        : "Session ended without a result message",
      costUsd: null,
    });
  }

  const costUsd = result.total_cost_usd;
  if (result.subtype !== "success") {
    return finish({
      status: result.subtype === "error_max_structured_output_retries" ? "invalid_output" : "error",
      output: null,
      rawText: "",
      error: [result.subtype, ...result.errors].join(": "),
      costUsd,
    });
  }
  if (result.is_error) {
    return finish({
      status: "error",
      output: null,
      rawText: result.result,
      error: result.result,
      costUsd,
    });
  }

  const parsed = task.schema.safeParse(result.structured_output);
  if (!parsed.success) {
    return finish({
      status: "invalid_output",
      output: null,
      rawText: result.result,
      error: z.prettifyError(parsed.error),
      costUsd,
    });
  }
  return finish({
    status: "ok",
    output: parsed.data,
    rawText: result.result,
    error: null,
    costUsd,
  });
}
