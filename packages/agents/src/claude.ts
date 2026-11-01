import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentResult, AgentTask, RunAgent, TokenUsage } from "@review-flow/core";
import { z } from "zod";
import { READ_ONLY_TOOLS, STRUCTURED_OUTPUT_TOOL } from "./guard.ts";
import { noResultError, runCli, type CliRun } from "./process.ts";

/** Headless `claude -p` profile (spec 9). */
export interface ClaudeOptions {
  bin: string;
}

const GUARD_HOOK = fileURLToPath(new URL("./guard-hook.ts", import.meta.url));

/**
 * The CLI validates `--json-schema` with a validator that doesn't know zod's default
 * draft-2020-12 `$schema` URI, so drop it; the schema itself uses only portable keywords.
 */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Settings passed with `--settings`: the guard hook, and no auto-memory. */
export function guardSettings(cwd: string, deniedLog: string): string {
  const command = [process.execPath, GUARD_HOOK, cwd, deniedLog].map(shellQuote).join(" ");
  return JSON.stringify({
    autoMemoryEnabled: false,
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] },
  });
}

/**
 * Flags for one task. The prompt goes on stdin and the shared context in a file, so large diffs
 * don't hit argv limits. The shared context is appended to the system prompt: unlike the user
 * message, the system prompt is cached as its own block, so later sessions read it from cache.
 */
export function claudeArgs(
  task: AgentTask<unknown>,
  settings: string,
  contextFile: string | null,
): string[] {
  const tools = READ_ONLY_TOOLS.join(",");
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(task.model === null ? [] : ["--model", task.model]),
    ...(task.effort === null ? [] : ["--effort", task.effort]),
    // Read-only: only these tools exist, they run without prompts, and nothing else is allowed.
    "--tools",
    tools,
    "--allowed-tools",
    tools,
    "--permission-mode",
    "dontAsk",
    // Isolation: no user/project/local settings (so no CLAUDE.md or their hooks), no MCP servers,
    // no slash commands or skills, no saved session.
    "--setting-sources",
    "",
    "--settings",
    settings,
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--json-schema",
    JSON.stringify(toOutputSchema(task.schema)),
    ...(contextFile === null ? [] : ["--append-system-prompt-file", contextFile]),
  ];
}

/** The fields of a `stream-json` message that the harness reads. */
interface StreamMessage {
  type?: string;
  subtype?: string;
  message?: { content?: { type?: string; name?: string; input?: unknown }[] };
  is_error?: boolean;
  result?: string;
  errors?: string[];
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

export function parseUsage(result: StreamMessage): TokenUsage | null {
  const usage = result.usage;
  if (usage === undefined) return null;
  return {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
}

type Outcome<T> = Omit<AgentResult<T>, "raw" | "durationMs">;

/** Turns the final `result` message into an outcome, validating the structured output. */
export function interpretResult<T>(result: StreamMessage, schema: z.ZodType<T>): Outcome<T> {
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
  const usage = parseUsage(result);
  const rawText = typeof result.result === "string" ? result.result : "";
  const fail = (status: Outcome<T>["status"], error: string): Outcome<T> => ({
    status,
    output: null,
    rawText,
    error,
    costUsd,
    usage,
  });

  if (result.subtype !== "success") {
    const status =
      result.subtype === "error_max_structured_output_retries" ? "invalid_output" : "error";
    return fail(status, [result.subtype ?? "unknown", ...(result.errors ?? [])].join(": "));
  }
  if (result.is_error === true) return fail("error", rawText);

  const parsed = schema.safeParse(result.structured_output);
  if (!parsed.success) return fail("invalid_output", z.prettifyError(parsed.error));
  return { status: "ok", output: parsed.data, rawText, error: null, costUsd, usage };
}

function describeToolInput(tool: string, input: Record<string, unknown>, cwd: string) {
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

function reportToolCalls(message: StreamMessage, task: AgentTask<unknown>): void {
  for (const block of message.message?.content ?? []) {
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    task.onProgress({ tool: block.name, detail: describeToolInput(block.name, input, task.cwd) });
  }
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

export function createClaudeAgent(options: ClaudeOptions): RunAgent {
  return async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    const startedAt = Date.now();
    const messages: unknown[] = [];
    let stderr = "";
    let denied: string[] = [];
    let args: string[] = [];
    const finish = (outcome: Outcome<T>): AgentResult<T> => ({
      ...outcome,
      raw: { args, messages, stderr, deniedToolCalls: denied },
      durationMs: Date.now() - startedAt,
    });
    const failure = (status: "error" | "timeout", error: string) =>
      finish({ status, output: null, rawText: "", error, costUsd: null, usage: null });

    // Covers a task dequeued just before its caller aborted.
    if (task.signal?.aborted) return failure("error", "Cancelled");

    const scratch = await mkdtemp(path.join(tmpdir(), "review-flow-claude-"));
    const deniedLog = path.join(scratch, "denied.log");
    let contextFile: string | null = null;
    if (task.sharedContext !== null) {
      contextFile = path.join(scratch, "context.md");
      await writeFile(contextFile, task.sharedContext);
    }
    args = claudeArgs(task as AgentTask<unknown>, guardSettings(task.cwd, deniedLog), contextFile);

    // Assigned in a callback, so the cast keeps TS from narrowing it to null.
    let result = null as StreamMessage | null;
    let run: CliRun;
    try {
      run = await runCli({
        bin: options.bin,
        args,
        cwd: task.cwd,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
        input: task.prompt,
        timeoutMs: task.timeoutMs,
        signal: task.signal,
        onMessage: (value) => {
          const message = value as StreamMessage;
          messages.push(message);
          if (message.type === "assistant") reportToolCalls(message, task as AgentTask<unknown>);
          if (message.type === "result") result = message;
        },
      });
      denied = await readLines(deniedLog);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    stderr = run.stderr;

    if (run.timedOut) return failure("timeout", `Timed out after ${task.timeoutMs} ms`);
    if (task.signal?.aborted) return failure("error", "Cancelled");
    if (run.error !== undefined) {
      return failure("error", `Could not run ${options.bin}: ${run.error.message}`);
    }
    if (result === null) return failure("error", noResultError(options.bin, run));
    return finish(interpretResult(result, task.schema));
  };
}
