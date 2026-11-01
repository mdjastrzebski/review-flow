import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentResult, AgentTask, RunAgent, TokenUsage } from "@review-flow/core";
import { z } from "zod";
import { READ_ONLY_TOOLS, STRUCTURED_OUTPUT_TOOL } from "./guard.ts";

/** Headless `claude -p` profile (spec 9). */
export interface ClaudeOptions {
  bin: string;
}

const GUARD_HOOK = fileURLToPath(new URL("./guard-hook.ts", import.meta.url));

/** After SIGTERM, how long the CLI gets to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 4_000;

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

/** Flags for one task. The prompt goes on stdin, so large diffs don't hit argv limits. */
export function claudeArgs(task: AgentTask<unknown>, settings: string): string[] {
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
    args = claudeArgs(task as AgentTask<unknown>, guardSettings(task.cwd, deniedLog));

    let timedOut = false;
    let result: StreamMessage | null = null;
    let exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error };
    try {
      const child = spawn(options.bin, args, {
        cwd: task.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      });
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, task.timeoutMs);
      task.signal?.addEventListener("abort", stop, { once: true });
      // An abort during `mkdtemp` already fired, so the listener above won't see it.
      if (task.signal?.aborted) stop();

      const exited = new Promise<typeof exit>((resolve) => {
        child.once("error", (error) => resolve({ code: null, signal: null, error }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      child.stdin.on("error", () => {}); // EPIPE if the CLI exits before reading the prompt.
      child.stdin.end(task.prompt);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      });

      for await (const line of createInterface({ input: child.stdout })) {
        if (line.trim() === "") continue;
        let message: StreamMessage;
        try {
          message = JSON.parse(line) as StreamMessage;
        } catch {
          messages.push({ unparsed: line });
          continue;
        }
        messages.push(message);
        if (message.type === "assistant") reportToolCalls(message, task as AgentTask<unknown>);
        if (message.type === "result") result = message;
      }
      exit = await exited;
      clearTimeout(timer);
      task.signal?.removeEventListener("abort", stop);
      denied = await readLines(deniedLog);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    if (timedOut) return failure("timeout", `Timed out after ${task.timeoutMs} ms`);
    if (task.signal?.aborted) return failure("error", "Cancelled");
    if (exit.error !== undefined) {
      return failure("error", `Could not run ${options.bin}: ${exit.error.message}`);
    }
    if (result === null) {
      const how = exit.signal === null ? `exit code ${exit.code}` : `signal ${exit.signal}`;
      const detail = stderr.trim();
      return failure(
        "error",
        `${options.bin} ended without a result (${how})${detail === "" ? "" : `: ${detail}`}`,
      );
    }
    return finish(interpretResult(result, task.schema));
  };
}
