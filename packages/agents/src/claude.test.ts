import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProgress, AgentTask } from "@review-flow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeArgs, createClaudeAgent, interpretResult } from "./claude.ts";

/**
 * Stands in for `claude -p`: reads the prompt on stdin and acts on the `mode:` it contains.
 * In `mode:hook` it runs the guard hook command from `--settings`, as the real CLI would.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const mode = /mode:(\\w+)/.exec(prompt)[1];
out({ type: "system", subtype: "init" });
if (mode === "crash") { process.stderr.write("boom"); process.exit(3); }
if (mode === "hang") setInterval(() => {}, 1000);
else {
  if (mode === "hook") {
    const command = JSON.parse(flag("--settings")).hooks.PreToolUse[0].hooks[0].command;
    for (const call of [
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { tool_name: "Read", tool_input: { file_path: "../secret" } },
      { tool_name: "Read", tool_input: { file_path: "src/a.ts" } },
    ]) {
      out({ type: "user", hook: execSync(command, { input: JSON.stringify(call) }).toString() });
    }
  }
  out({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Read", input: { file_path: process.cwd() + "/src/a.ts" } },
  ] } });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    structured_output: mode === "bad" ? { nope: 1 } : { answer: "hi" },
    total_cost_usd: 0.12,
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 40 },
  });
}
`;

const Answer = z.object({ answer: z.string() });

let sandbox: string;
let repo: string;
let bin: string;

beforeAll(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "review-flow-claude-test-")));
  repo = path.join(sandbox, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "a.ts"), "");
  bin = path.join(sandbox, "fake-claude.mjs");
  await writeFile(bin, FAKE_CLAUDE);
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
      cwd: repo,
      schema: Answer,
      model: "claude-opus-5-5",
      effort: "high",
      timeoutMs: 30_000,
      onProgress: (event) => progress.push(event),
      ...overrides,
    } satisfies AgentTask<{ answer: string }>,
  };
}

describe("claudeArgs", () => {
  it("passes read-only, isolation, model, and schema flags", () => {
    const args = claudeArgs(task("ok").task as AgentTask<unknown>, "{}");
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain("-p");
    expect(value("--output-format")).toBe("stream-json");
    expect(value("--model")).toBe("claude-opus-5-5");
    expect(value("--effort")).toBe("high");
    expect(value("--tools")).toBe("Read,Grep,Glob");
    expect(value("--allowed-tools")).toBe("Read,Grep,Glob");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--setting-sources")).toBe("");
    expect(value("--settings")).toBe("{}");
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]),
    );
    const schema = JSON.parse(value("--json-schema") ?? "") as Record<string, unknown>;
    expect(schema).toMatchObject({ type: "object", required: ["answer"] });
    expect(schema).not.toHaveProperty("$schema");
  });

  it("omits model and effort when unset", () => {
    const args = claudeArgs(
      task("ok", { model: null, effort: null }).task as AgentTask<unknown>,
      "{}",
    );
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });
});

describe("interpretResult", () => {
  it("maps structured-output retries to invalid_output", () => {
    const outcome = interpretResult(
      { subtype: "error_max_structured_output_retries", errors: ["gave up"] },
      Answer,
    );
    expect(outcome).toMatchObject({ status: "invalid_output", costUsd: null, usage: null });
    expect(outcome.error).toContain("gave up");
  });

  it("maps other error subtypes to error, keeping cost", () => {
    const outcome = interpretResult(
      { subtype: "error_max_turns", total_cost_usd: 0.3, errors: [] },
      Answer,
    );
    expect(outcome).toMatchObject({ status: "error", costUsd: 0.3 });
  });
});

describe("createClaudeAgent", () => {
  const agent = () => createClaudeAgent({ bin });

  it("returns validated output, cost, tokens, and progress", async () => {
    const { task: t, progress } = task("ok");
    const result = await agent()(t);
    expect(result).toMatchObject({
      status: "ok",
      output: { answer: "hi" },
      rawText: "done",
      costUsd: 0.12,
      usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
    });
    expect(progress).toEqual([{ tool: "Read", detail: path.join("src", "a.ts") }]);
  });

  it("runs the guard hook from --settings and records denials", async () => {
    const result = await agent()(task("hook").task);
    expect(result.status).toBe("ok");
    const raw = result.raw as { messages: { hook?: string }[]; deniedToolCalls: string[] };
    const hooks = raw.messages.flatMap((m) => (m.hook === undefined ? [] : [m.hook]));
    expect(JSON.parse(hooks[0] ?? "")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.parse(hooks[1] ?? "")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(hooks[2]).toBe("");
    expect(raw.deniedToolCalls).toEqual([
      expect.stringMatching(/^Bash: /),
      expect.stringMatching(/^Read: \.\.\/secret is outside/),
    ]);
  });

  it("reports schema mismatches as invalid_output", async () => {
    const result = await agent()(task("bad").task);
    expect(result).toMatchObject({ status: "invalid_output", output: null, costUsd: 0.12 });
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

  it("stops when the caller aborts while the session is being set up", async () => {
    const controller = new AbortController();
    const running = agent()(task("hang", { signal: controller.signal }).task);
    controller.abort();
    expect(await running).toMatchObject({ status: "error", error: "Cancelled" });
  });

  it("reports a missing binary", async () => {
    const missing = createClaudeAgent({ bin: path.join(sandbox, "no-such-claude") });
    const result = await missing(task("ok").task);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Could not run/);
  });
});
