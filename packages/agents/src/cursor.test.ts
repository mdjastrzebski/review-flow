import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProgress, AgentTask } from "@review-flow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createCursorAgent,
  cursorArgs,
  cursorPrompt,
  extractJsonObjects,
  parseAnswer,
} from "./cursor.ts";

/**
 * Stands in for `agent -p`: reads the prompt on stdin and acts on the `mode:` it contains. A
 * `--resume` call is the repair retry and answers correctly.
 */
const FAKE_AGENT = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const args = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify({ session_id: "s-1", ...event }) + "\\n");
const resumed = args.includes("--resume");
const mode = resumed ? "ok" : /mode:(\\w+)/.exec(prompt)[1];
const usage = { inputTokens: 10, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 30 };
const tool = (name, args, result) => {
  const key = name + "ToolCall";
  out({ type: "tool_call", subtype: "started", tool_call: { [key]: { args } } });
  out({ type: "tool_call", subtype: "completed", tool_call: { [key]: { args, result } } });
};
out({ type: "system", subtype: "init" });
out({ type: "thinking", subtype: "delta", text: "hmm" });
if (mode === "crash") { process.stderr.write("boom"); process.exit(3); }
if (mode === "hang") setInterval(() => {}, 1000);
else {
  tool("read", { path: process.cwd() + "/src/a.ts" }, { success: {} });
  if (mode === "denied") tool("shell", { command: "ls" }, { rejected: {} });
  if (mode === "outside") tool("read", { path: "/etc/hosts" }, { success: {} });
  if (mode === "escape") {
    tool("shell", { command: "ls" }, { success: {} });
    setInterval(() => {}, 1000);
  } else {
    const config = process.env.CURSOR_CONFIG_DIR;
    const result = mode === "bad" ? "Done: {\\"answer\\": 1}"
      : mode === "config" ? JSON.stringify({ answer: config + "|" + readFileSync(config + "/cli-config.json", "utf8") })
      : "Here it is: {\\"answer\\": \\"hi\\"}";
    out({ type: "result", subtype: "success", is_error: false, result, usage });
  }
}
`;

const Answer = z.object({ answer: z.string() });

let sandbox: string;
let repo: string;
let bin: string;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "review-flow-cursor-test-")));
  repo = path.join(sandbox, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "a.ts"), "");
  bin = path.join(sandbox, "fake-agent.mjs");
  await writeFile(bin, FAKE_AGENT);
  await chmod(bin, 0o755);
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function task(mode: string, overrides: Partial<AgentTask<{ answer: string }>> = {}) {
  const progress: AgentProgress[] = [];
  return {
    progress,
    task: {
      taskId: "reviewer",
      role: "reviewer",
      prompt: `mode:${mode}`,
      sharedContext: null,
      cwd: repo,
      schema: Answer,
      model: "grok-4.7-high",
      effort: null,
      timeoutMs: 30_000,
      onProgress: (event) => progress.push(event),
      ...overrides,
    } satisfies AgentTask<{ answer: string }>,
  };
}

describe("cursorArgs", () => {
  it("passes read-only flags and the model", () => {
    const args = cursorArgs("grok-4.7-high", null, null);
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--mode",
      "ask",
      "--sandbox",
      "enabled",
      "--trust",
      "--model",
      "grok-4.7-high",
    ]);
    expect(args).not.toContain("--force");
  });

  it("puts effort in brackets, and resumes a session", () => {
    const args = cursorArgs("claude-opus-5-5", "high", "s-1");
    expect(args).toEqual(
      expect.arrayContaining(["--model", "claude-opus-5-5[effort=high]", "--resume", "s-1"]),
    );
  });

  it("omits the model when unset", () => {
    expect(cursorArgs(null, "high", null)).not.toContain("--model");
  });
});

describe("cursorPrompt", () => {
  it("puts the shared context first and the schema last", () => {
    const prompt = cursorPrompt(
      task("ok", { sharedContext: "THE DIFF" }).task as AgentTask<unknown>,
    );
    expect(prompt.startsWith("THE DIFF\n\nmode:ok")).toBe(true);
    expect(prompt).toMatch(/"required": \[\s*"answer"\s*\]/);
  });
});

describe("parseAnswer", () => {
  it("takes the last object that fits the schema, skipping prose and stray objects", () => {
    const text = 'I read {a}. ```json\n{"answer": "x"}\n``` then {"other": 1}';
    expect(parseAnswer(text, Answer)).toEqual({ ok: true, value: { answer: "x" } });
  });

  it("reports a malformed answer as a syntax error", () => {
    // Only the nested object parses; it must not hide that the answer itself is malformed.
    const parsed = parseAnswer('{"answer": "x", "n": {"a": 1},}', Answer);
    expect(parsed).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid JSON/) });
  });

  it("does not let a nested object stand in for its parent", () => {
    expect(extractJsonObjects('{"a": {"answer": "x"}}').values).toEqual([{ a: { answer: "x" } }]);
  });
});

describe("createCursorAgent", () => {
  const agent = () => createCursorAgent({ bin });

  it("returns parsed output, tokens, and progress, without a cost", async () => {
    const { task: t, progress } = task("ok");
    const result = await agent()(t);
    expect(result).toMatchObject({
      status: "ok",
      output: { answer: "hi" },
      costUsd: null,
      usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
    });
    expect(progress).toEqual([{ tool: "Read", detail: path.join("src", "a.ts") }]);
    const raw = result.raw as { attempts: { events: { type?: string }[] }[] };
    expect(raw.attempts[0]?.events.some((e) => e.type === "thinking")).toBe(false);
  });

  it("repairs an invalid answer once in the same session, summing tokens", async () => {
    const { task: t, progress } = task("bad");
    const result = await agent()(t);
    expect(result).toMatchObject({
      status: "ok",
      output: { answer: "hi" },
      usage: { input: 20, cacheRead: 40, cacheWrite: 60, output: 80 },
    });
    expect(progress.map((p) => p.tool)).toContain("Repair");
    const raw = result.raw as { attempts: { args: string[] }[] };
    expect(raw.attempts[1]?.args).toEqual(expect.arrayContaining(["--resume", "s-1"]));
  });

  it("runs with its own empty config dir, removed afterwards", async () => {
    const result = await agent()(task("config").task);
    const [dir = "", config = ""] = result.output?.answer.split("|") ?? [];
    expect(JSON.parse(config)).toEqual({ version: 1, permissions: { allow: [], deny: [] } });
    expect(dir).toContain("review-flow-cursor-");
    expect(existsSync(dir)).toBe(false);
  });

  it("records forbidden calls that Cursor refused", async () => {
    const result = await agent()(task("denied").task);
    expect(result.status).toBe("ok");
    expect((result.raw as { deniedToolCalls: string[] }).deniedToolCalls).toEqual([
      expect.stringMatching(/^Shell: /),
    ]);
  });

  it("records a read outside the repo that ran, and goes on", async () => {
    const { task: t, progress } = task("outside");
    const result = await agent()(t);
    expect(result).toMatchObject({
      status: "ok",
      outsideReads: [expect.stringMatching(/^Read: \/etc\/hosts is outside/)],
    });
    expect(progress.map((p) => p.tool)).toContain("Outside read");
  });

  it("stops the session when any other forbidden call ran", async () => {
    const result = await agent()(task("escape").task);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Forbidden tool call ran: Shell: /);
  });

  it("reports a crash with the exit code and stderr", async () => {
    const result = await agent()(task("crash").task);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/exit code 3.*boom/);
  });

  it("times out a hung session", async () => {
    const result = await agent()(task("hang", { timeoutMs: 500 }).task);
    expect(result).toMatchObject({ status: "timeout", output: null });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await agent()(task("hang", { signal: controller.signal }).task);
    expect(result).toMatchObject({ status: "error", error: "Cancelled" });
  });

  it("reports a missing binary", async () => {
    const missing = createCursorAgent({ bin: path.join(sandbox, "no-such-agent") });
    const result = await missing(task("ok").task);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Could not run/);
  });
});
