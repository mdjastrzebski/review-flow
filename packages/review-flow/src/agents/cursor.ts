import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentProgress,
  AgentResult,
  AgentTask,
  Effort,
  RunAgent,
  TokenUsage,
} from "../core/index.ts";
import { z } from "zod";
import { toOutputSchema } from "./claude.ts";
import { globEscapes, isInsideRoot } from "./guard.ts";
import { noResultError, runCli, type CliRun } from "./process.ts";

/** Headless `agent -p` (Cursor CLI) profile (spec 9). */
export interface CursorOptions {
  bin: string;
}

/** Error text fed back to the agent in the repair prompt is capped so it can't swamp the turn. */
const MAX_REPAIR_ERROR_CHARS = 2000;

interface JsonCandidates {
  /** Top-level JSON objects, last first. */
  values: unknown[];
  /** Why a `{…}` enclosing the last value failed to parse: likely the intended answer, malformed. */
  syntaxError: string | null;
}

/**
 * Finds the top-level JSON objects in free text. Cursor has no structured output, and its result
 * text is every assistant message of the turn run together, so the answer may be preceded by
 * prose ("I'll read a.ts…"), sit in a code fence, or be followed by more text.
 */
export function extractJsonObjects(text: string): JsonCandidates {
  const values: unknown[] = [];
  let syntaxError: string | null = null;
  let failed: { end: number; error: string } | null = null;
  for (let start = text.indexOf("{"); start !== -1;) {
    const end = matchingBrace(text, start);
    if (end !== -1) {
      try {
        values.unshift(JSON.parse(text.slice(start, end + 1)));
        syntaxError = failed !== null && start < failed.end ? failed.error : null;
        // Skip what's inside a parsed object, so a nested object never stands in for its parent.
        start = text.indexOf("{", end + 1);
        continue;
      } catch (error) {
        // Not JSON (e.g. a code snippet in prose); try the next brace.
        if (failed === null || start > failed.end) {
          failed = { end, error: (error as Error).message };
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return { values, syntaxError };
}

/** Index of the `}` closing the `{` at `start`, skipping braces inside strings; -1 if none. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** The last JSON object in the text that fits the schema, so stray objects after it don't matter. */
export function parseAnswer<T>(text: string, schema: z.ZodType<T>): ParseOutcome<T> {
  const { values, syntaxError } = extractJsonObjects(text);
  if (values.length === 0) {
    return { ok: false, error: "No JSON object found in the agent's answer." };
  }
  let firstError: z.ZodError | null = null;
  for (const value of values) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    firstError ??= parsed.error;
  }
  // Fragments of a malformed answer would make a misleading repair prompt; report the syntax error.
  if (syntaxError !== null) return { ok: false, error: `Invalid JSON: ${syntaxError}` };
  return { ok: false, error: z.prettifyError(firstError!) };
}

/**
 * The prompt on stdin. Cursor has no system prompt flag, so the shared context goes first: the
 * same prefix in every session gives Cursor's prompt cache a chance to reuse it. Cursor can't
 * enforce a schema, so the prompt carries it.
 */
export function cursorPrompt(task: AgentTask<unknown>): string {
  return [
    ...(task.sharedContext === null ? [] : [task.sharedContext.trimEnd()]),
    task.prompt.trimEnd(),
    "## Required output",
    "Your final message must be only a JSON object matching this JSON Schema: no prose before or after it.",
    `\`\`\`json\n${JSON.stringify(toOutputSchema(task.schema), null, 2)}\n\`\`\``,
  ].join("\n\n");
}

function repairPrompt(error: string): string {
  const detail =
    error.length > MAX_REPAIR_ERROR_CHARS ? `${error.slice(0, MAX_REPAIR_ERROR_CHARS)}…` : error;
  return [
    "Your final answer could not be used:",
    detail,
    "Reply with only the corrected JSON object matching the required schema, and no other text. Do not redo the analysis.",
  ].join("\n\n");
}

/**
 * `--mode ask` makes the session read-only and `--sandbox enabled` refuses shell, even for
 * commands on the user's allowlist; `--force` and `--approve-mcps` are never passed. Effort goes
 * in Cursor's bracket syntax, `claude-opus-5-5[effort=high]`.
 */
export function cursorArgs(
  model: string | null,
  effort: Effort | null,
  resume: string | null,
): string[] {
  const modelArg = model === null ? null : effort === null ? model : `${model}[effort=${effort}]`;
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--trust",
    ...(modelArg === null ? [] : ["--model", modelArg]),
    ...(resume === null ? [] : ["--resume", resume]),
  ];
}

interface ToolCall {
  /** `read`, `glob`, `shell`, … */
  name: string;
  args: Record<string, unknown>;
  /** Only on `completed` events: `{ success: … }`, `{ rejected: … }`, `{ permissionDenied: … }`, … */
  result: unknown;
}

/** Tool calls arrive as `{ readToolCall: { args, result? } }`, `{ globToolCall: { args } }`, … */
function parseToolCall(toolCall: unknown): ToolCall | null {
  if (typeof toolCall !== "object" || toolCall === null) return null;
  const key = Object.keys(toolCall).find((k) => k.endsWith("ToolCall"));
  if (key === undefined) return null;
  const body = (toolCall as Record<string, { args?: unknown; result?: unknown }>)[key];
  return {
    name: key.slice(0, -"ToolCall".length),
    args: (body?.args ?? {}) as Record<string, unknown>,
    result: body?.result,
  };
}

const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Repo-relative inside the repo, absolute outside it. */
function displayPath(cwd: string, target: string): string {
  const absolute = path.resolve(cwd, target);
  const relative = path.relative(cwd, absolute);
  return relative.startsWith("..") ? absolute : relative || ".";
}

function describeToolCall({ name, args }: ToolCall, cwd: string): AgentProgress {
  const tool = displayName(name);
  const str = (k: string) => (typeof args[k] === "string" ? args[k] : null);
  const target = str("path") ?? str("targetDirectory");
  const where = target === null ? null : displayPath(cwd, target);
  const pattern = str("globPattern") ?? str("pattern");
  if (pattern === null) return { tool, detail: where };
  return { tool, detail: where === null ? pattern : `${pattern} in ${where}` };
}

/** Read-only Cursor tools, allowed only on paths inside the repo. */
const READ_TOOLS = new Set(["read", "glob", "grep", "ls"]);

/** Tools with neither paths nor side effects: looking up a tool's schema, the agent's todo list. */
const INERT_TOOLS = new Set(["getMcpTools", "readTodos", "updateTodos"]);

const PATH_ARGS = ["path", "targetDirectory"];
const GLOB_ARGS = ["globPattern", "glob"];

/** Why the call isn't allowed in a read-only review of `cwd`; null if it is. */
async function forbiddenReason({ name, args }: ToolCall, cwd: string): Promise<string | null> {
  if (INERT_TOOLS.has(name)) return null;
  if (!READ_TOOLS.has(name)) {
    return `${displayName(name)} is not available; this session is read-only.`;
  }
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value === "string" && !(await isInsideRoot(cwd, value))) {
      return `${value} is outside the repository.`;
    }
  }
  for (const key of GLOB_ARGS) {
    const value = args[key];
    if (typeof value === "string" && globEscapes(value)) {
      return `${value} must be a relative pattern without "..".`;
    }
  }
  return null;
}

/** Anything but an explicit refusal counts as having run. */
function ran(result: unknown): boolean {
  return typeof result !== "object" || result === null || "success" in result;
}

/**
 * Cursor offers no way to stop a tool call before it runs: print mode has no hook. Ask mode and
 * the sandbox refuse shell, writes, MCP and web fetches, but reads outside the repo still succeed.
 * So each call is checked once it completes. A forbidden call Cursor refused is recorded as
 * denied. A read outside the repo that ran is recorded and the session goes on: with no network,
 * what it read can only reach the report. Any other forbidden call that ran is an escape, and
 * stops the session.
 */
function toolCallGuard(cwd: string, onOutsideRead: (entry: string) => void) {
  const denied: string[] = [];
  const outsideReads: string[] = [];
  const escaped: string[] = [];
  const checks: Promise<void>[] = [];
  let stop = () => {};
  return {
    denied,
    outsideReads,
    escaped,
    setStop(fn: () => void): void {
      stop = fn;
    },
    completed(call: ToolCall): void {
      checks.push(
        forbiddenReason(call, cwd).then((reason) => {
          if (reason === null) return;
          const entry = `${displayName(call.name)}: ${reason}`;
          if (!ran(call.result)) return void denied.push(entry);
          if (READ_TOOLS.has(call.name)) {
            outsideReads.push(entry);
            return onOutsideRead(entry);
          }
          escaped.push(entry);
          stop();
        }),
      );
    },
    /** Resolves once every call seen so far has been checked. */
    settled: () => Promise.all(checks),
  };
}

/** The fields of a `stream-json` event that the harness reads. */
interface CursorEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  tool_call?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export function parseCursorUsage(result: CursorEvent): TokenUsage | null {
  const usage = result.usage;
  if (usage === undefined) return null;
  return {
    input: usage.inputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens ?? 0,
  };
}

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null || b === null) return a ?? b;
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

interface Attempt {
  args: string[];
  prompt: string;
  events: unknown[];
  stderr: string;
  sessionId: string | null;
  /** The final `result` event, or null if the CLI never sent one. */
  result: CursorEvent | null;
}

/**
 * Runs one task through Cursor's `agent` CLI in print mode. Each invocation without `--resume` is
 * a fresh session. A malformed answer gets one repair retry that resumes the task's own session,
 * so the agent only restates its answer instead of redoing the work. Cursor reports tokens but no
 * cost; the pipeline computes cost from the price table.
 *
 * Each task gets its own empty config dir (`CURSOR_CONFIG_DIR`), so the user's CLI settings, such
 * as their shell allowlist, don't apply, and its chats aren't saved with the user's. Login still
 * works: it isn't stored there.
 */
export function createCursorAgent(options: CursorOptions): RunAgent {
  return async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    const startedAt = Date.now();
    const attempts: Attempt[] = [];
    const guard = toolCallGuard(task.cwd, (entry) =>
      task.onProgress({ tool: "Outside read", detail: entry }),
    );
    let usage: TokenUsage | null = null;
    const finish = (
      fields: Pick<AgentResult<T>, "status" | "output" | "rawText" | "error">,
    ): AgentResult<T> => ({
      ...fields,
      raw: { attempts, deniedToolCalls: guard.denied, escapedToolCalls: guard.escaped },
      outsideReads: guard.outsideReads,
      costUsd: null,
      usage,
      durationMs: Date.now() - startedAt,
    });
    const failure = (status: "error" | "timeout", error: string, rawText = "") =>
      finish({ status, output: null, rawText, error });

    // Covers a task dequeued just before its caller aborted.
    if (task.signal?.aborted) return failure("error", "Cancelled");

    const configDir = await mkdtemp(path.join(tmpdir(), "review-flow-cursor-"));
    await writeFile(
      path.join(configDir, "cli-config.json"),
      JSON.stringify({ version: 1, permissions: { allow: [], deny: [] } }),
    );
    const env = { ...process.env, CURSOR_CONFIG_DIR: configDir };

    const attempt = async (prompt: string, resume: string | null) => {
      const current: Attempt = {
        args: cursorArgs(task.model, task.effort, resume),
        prompt,
        events: [],
        stderr: "",
        sessionId: null,
        result: null,
      };
      attempts.push(current);
      const run: CliRun = await runCli({
        bin: options.bin,
        args: current.args,
        cwd: task.cwd,
        env,
        input: prompt,
        timeoutMs: task.timeoutMs - (Date.now() - startedAt),
        signal: task.signal,
        onStart: guard.setStop,
        onMessage: (value) => {
          const event = value as CursorEvent;
          // Thinking deltas are one event per few tokens; they'd bloat the raw record.
          if (event.type === "thinking") return;
          current.events.push(event);
          current.sessionId ??= event.session_id ?? null;
          if (event.type === "result") current.result = event;
          const toolCall = event.type === "tool_call" ? parseToolCall(event.tool_call) : null;
          if (toolCall === null) return;
          if (event.subtype === "started") task.onProgress(describeToolCall(toolCall, task.cwd));
          if (event.subtype === "completed") guard.completed(toolCall);
        },
      });
      await guard.settled();
      current.stderr = run.stderr;
      if (current.result !== null) usage = addUsage(usage, parseCursorUsage(current.result));
      return { run, current };
    };

    try {
      let { run, current } = await attempt(cursorPrompt(task as AgentTask<unknown>), null);
      for (let repaired = false; ; repaired = true) {
        const rawText = current.result?.result ?? "";
        if (guard.escaped.length > 0) {
          return failure("error", `Forbidden tool call ran: ${guard.escaped.join("; ")}`, rawText);
        }
        if (run.timedOut) return failure("timeout", `Timed out after ${task.timeoutMs} ms`);
        if (task.signal?.aborted) return failure("error", "Cancelled");
        if (run.error !== undefined) {
          return failure("error", `Could not run ${options.bin}: ${run.error.message}`);
        }
        if (current.result === null) return failure("error", noResultError(options.bin, run));
        if (current.result.is_error === true || current.result.subtype !== "success") {
          return failure("error", rawText || `Result subtype: ${current.result.subtype}`, rawText);
        }

        const parsed = parseAnswer(rawText, task.schema);
        if (parsed.ok) return finish({ status: "ok", output: parsed.value, rawText, error: null });
        if (repaired || current.sessionId === null) {
          return finish({ status: "invalid_output", output: null, rawText, error: parsed.error });
        }
        task.onProgress({ tool: "Repair", detail: "answer was not valid; asking once more" });
        ({ run, current } = await attempt(repairPrompt(parsed.error), current.sessionId));
      }
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  };
}
