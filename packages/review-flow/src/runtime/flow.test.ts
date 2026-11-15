import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import { defineFlow, startRun, type Flow, type FlowContext, type StartRunOptions } from "./flow.ts";
import { flattenTree, type CallRecord, type FlowNode, type RunRecordBase } from "./records.ts";
import { createRunDirAt, type RunDirBase } from "./run-dir.ts";

let tmp: string;
let dir: RunDirBase;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "review-flow-runtime-"));
  dir = await createRunDirAt(path.join(tmp, "run"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const Answer = z.object({ ok: z.boolean() });

/** Answers every task; `effect` runs first, e.g. to wait or to report activity. */
function fakeAgent(
  config: {
    effect?: (task: AgentTask<unknown>) => Promise<void>;
    costUsd?: number | null;
  } = {},
): { runAgent: RunAgent; tasks: AgentTask<unknown>[] } {
  const tasks: AgentTask<unknown>[] = [];
  const runAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    tasks.push(task as AgentTask<unknown>);
    await config.effect?.(task as AgentTask<unknown>);
    return {
      status: "ok",
      output: task.schema.parse({ ok: true }),
      rawText: "{}",
      raw: { task: task.taskId },
      error: null,
      costUsd: config.costUsd === undefined ? 0.5 : config.costUsd,
      usage: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      durationMs: 5,
    };
  };
  return { runAgent, tasks };
}

const task = (taskId: string) => ({
  taskId,
  role: "tester",
  prompt: `prompt of ${taskId}`,
  sharedContext: null,
  cwd: tmp,
  schema: Answer,
  model: "claude-sonnet-5-5",
  effort: null,
  timeoutMs: 1000,
});

function options(runAgent: RunAgent, overrides: Partial<StartRunOptions> = {}): StartRunOptions {
  return { dir, runAgent, harness: "fake", log: () => {}, onActivity: () => {}, ...overrides };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readCalls(file: string): Promise<CallRecord[]> {
  return (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as CallRecord);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ctx.agent", () => {
  it("saves the prompt and raw output, records the call with its path, then runs afterCall", async () => {
    const { runAgent } = fakeAgent();
    const after: CallRecord[] = [];
    const flow = defineFlow("root", async (_: null, ctx) => {
      await ctx.step("ask", (c) => c.agent(task("t1")));
    });
    await startRun(flow, null, options(runAgent, { afterCall: async (c) => void after.push(c) }));

    expect(await readFile(dir.promptPath("t1"), "utf8")).toBe("prompt of t1");
    expect(await readJson(dir.rawPath("t1"))).toEqual({ task: "t1" });
    const calls = await readCalls(dir.callsPath);
    expect(calls).toEqual([
      expect.objectContaining({
        taskId: "t1",
        role: "tester",
        path: "root/ask",
        harness: "fake",
        costUsd: 0.5,
        costSource: "reported",
      }),
    ]);
    expect(after).toEqual(calls);
  });

  it("computes the cost from tokens when the harness reports none", async () => {
    const { runAgent } = fakeAgent({ costUsd: null });
    const flow = defineFlow("root", async (_: null, ctx) => (await ctx.agent(task("t1"))).call);
    const call = await startRun(flow, null, options(runAgent));
    expect(call).toMatchObject({ costUsd: 2, costSource: "computed" });
  });

  it("fails the call when afterCall throws, keeping its record", async () => {
    const { runAgent } = fakeAgent();
    const flow = defineFlow("root", async (_: null, ctx) => ctx.agent(task("t1")));
    await expect(
      startRun(
        flow,
        null,
        options(runAgent, {
          afterCall: async () => {
            throw new Error("tree changed");
          },
        }),
      ),
    ).rejects.toThrow("tree changed");
    expect(await readCalls(dir.callsPath)).toHaveLength(1);
    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    expect(run).toMatchObject({ status: "failed", error: "tree changed", totals: { calls: 1 } });
  });

  it("passes the scope's signal unless the task has its own", async () => {
    const { runAgent, tasks } = fakeAgent();
    const flow = defineFlow("root", async (_: null, ctx) => {
      await ctx.agent(task("t1"));
    });
    await startRun(flow, null, options(runAgent));
    expect(tasks[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("tree", () => {
  it("nests flows and steps, with totals that include descendants", async () => {
    const { runAgent } = fakeAgent();
    const leaf: Flow<string, void> = defineFlow("leaf", async (id, ctx) => {
      await ctx.agent(task(id));
    });
    const root = defineFlow("root", async (_: null, ctx) => {
      await ctx.agent(task("own"));
      await ctx.step("group", async (c) => {
        await c.run(leaf, "a");
        await c.run(leaf, "b", { name: "leaf:b" });
      });
      return ctx.snapshot();
    });
    const live = await startRun(root, null, options(runAgent));
    expect(live.status).toBe("running");

    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    const flow = run.flow!;
    expect(flow).toMatchObject({ name: "root", kind: "flow", status: "ok" });
    expect(flow.totals).toMatchObject({ calls: 3, costUsd: 1.5 });
    const [group] = flow.children;
    expect(group).toMatchObject({ name: "group", kind: "step", totals: { calls: 2 } });
    expect(group?.children.map((c: FlowNode) => [c.name, c.kind, c.totals.calls])).toEqual([
      ["leaf", "flow", 1],
      ["leaf:b", "flow", 1],
    ]);
    expect((await readCalls(dir.callsPath)).map((c) => c.path)).toEqual([
      "root",
      "root/group/leaf",
      "root/group/leaf:b",
    ]);
    expect(run.totals).toMatchObject({ calls: 3, costUsd: 1.5 });
  });

  it("records steps timed before the run as its first children", async () => {
    const { runAgent } = fakeAgent();
    const startedAt = new Date(Date.now() - 1000);
    const flow = defineFlow("root", async () => {});
    await startRun(
      flow,
      null,
      options(runAgent, { before: [{ name: "collect", startedAt, durationMs: 900 }] }),
    );
    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    expect(run.startedAt).toBe(startedAt.toISOString());
    expect(run.flow?.children).toEqual([
      expect.objectContaining({ name: "collect", kind: "step", durationMs: 900 }),
    ]);
    expect(run.totals.durationMs).toBeGreaterThanOrEqual(1000);
  });
});

describe("startRun", () => {
  it("writes run.json as running first, then the final record, and calls onFinish", async () => {
    const { runAgent } = fakeAgent();
    let during: RunRecordBase | null = null;
    const finished: RunRecordBase[] = [];
    const flow = defineFlow("root", async (_: null, ctx) => {
      during = await readJson<RunRecordBase>(dir.runJsonPath);
      ctx.annotate({ note: "added" });
    });
    await startRun(
      flow,
      null,
      options(runAgent, {
        meta: { harness: "fake" },
        onFinish: async (record) => void finished.push(record),
      }),
    );
    expect(during).toMatchObject({
      format: 2,
      harness: "fake",
      status: "running",
      pid: process.pid,
      finishedAt: null,
      flow: null,
    });
    const run = await readJson<RunRecordBase & Record<string, unknown>>(dir.runJsonPath);
    expect(run).toMatchObject({ format: 2, harness: "fake", note: "added", status: "ok" });
    expect(run.pid).toBeUndefined();
    expect(finished).toEqual([run]);
  });

  it("writes the failed record and calls onFinish when the flow throws", async () => {
    const { runAgent } = fakeAgent();
    const finished: RunRecordBase[] = [];
    const flow = defineFlow("root", async (_: null, ctx) => {
      await ctx.step("first", async () => {});
      await ctx.step("broken", async () => {
        throw new Error("boom");
      });
    });
    await expect(
      startRun(flow, null, options(runAgent, { onFinish: async (r) => void finished.push(r) })),
    ).rejects.toThrow("boom");
    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    expect(run).toMatchObject({ status: "failed", error: "boom", flow: { status: "failed" } });
    expect(run.flow?.children.map((c) => [c.name, c.status, c.error])).toEqual([
      ["first", "ok", null],
      ["broken", "failed", "boom"],
    ]);
    expect(finished).toHaveLength(1);
  });
});

describe("ctx.parallel", () => {
  it("returns each branch's result by name", async () => {
    const { runAgent } = fakeAgent();
    const flow = defineFlow("root", async (_: null, ctx) =>
      ctx.parallel({ a: async () => 1, b: async () => "two" }),
    );
    expect(await startRun(flow, null, options(runAgent))).toEqual({ a: 1, b: "two" });
  });

  it("aborts the other branches on the first throw, and rethrows it once all settle", async () => {
    const { runAgent } = fakeAgent();
    const events: string[] = [];
    const slow = defineFlow("slow", async (_: null, ctx) => {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await sleep(10);
      events.push("slow settled");
      throw new Error("aborted late");
    });
    const failing = defineFlow("failing", async () => {
      await sleep(5);
      throw new Error("first");
    });
    const flow = defineFlow("root", async (_: null, ctx) =>
      ctx.parallel({
        slow: (c) => c.run(slow, null),
        failing: (c) => c.run(failing, null),
      }),
    );
    const error = await startRun(flow, null, options(runAgent)).catch((e: unknown) => e);
    events.push("rethrown");
    expect((error as Error).message).toBe("first");
    expect(events).toEqual(["slow settled", "rethrown"]);
    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    expect(run.flow?.children.map((c) => [c.name, c.status])).toEqual([
      ["slow", "aborted"],
      ["failing", "failed"],
    ]);
  });
});

describe("ctx.map", () => {
  const items = ["a", "b", "c", "d", "e", "f"];

  it("bounds concurrency and keeps the results in order", async () => {
    let active = 0;
    let maxActive = 0;
    const { runAgent } = fakeAgent({
      effect: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active--;
      },
    });
    const flow = defineFlow("root", async (_: null, ctx) =>
      ctx.map(
        items,
        async (item, index, c) => {
          await c.agent(task(item));
          return `${index}:${item}`;
        },
        { concurrency: 3 },
      ),
    );
    expect(await startRun(flow, null, options(runAgent))).toEqual(
      items.map((item, i) => `${i}:${item}`),
    );
    expect(maxActive).toBe(3);
  });

  it("with warmFirst, starts the rest once the first item shows agent activity", async () => {
    const events: string[] = [];
    const { runAgent } = fakeAgent({
      effect: async (t) => {
        events.push(`start ${t.taskId}`);
        if (t.taskId !== "a") return;
        await sleep(20);
        events.push("activity");
        t.onProgress({ tool: "Read", detail: null });
        await sleep(20);
      },
    });
    const item = defineFlow("item", async (id: string, ctx) => {
      await ctx.agent(task(id));
    });
    const flow = defineFlow("root", async (_: null, ctx) =>
      ctx.map(items.slice(0, 3), (id, _i, c) => c.run(item, id, { name: `item:${id}` }), {
        concurrency: 3,
        warmFirst: true,
      }),
    );
    await startRun(flow, null, options(runAgent));
    expect(events.slice(0, 2)).toEqual(["start a", "activity"]);
    expect(events).toHaveLength(4);
  });

  it("on a throw, starts no queued item, aborts in-flight ones, and rethrows after they settle", async () => {
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    const { runAgent } = fakeAgent({
      effect: async (t) => {
        started.push(t.taskId);
        signals.push(t.signal!);
        if (t.taskId === "b") throw new Error("b broke");
        // A session started after the abort ends at once.
        if (t.signal?.aborted) return;
        await new Promise<void>((resolve) =>
          t.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const flow = defineFlow("root", async (_: null, ctx: FlowContext) =>
      ctx.map(items, (id, _i, c) => c.agent(task(id)), { concurrency: 3 }),
    );
    await expect(startRun(flow, null, options(runAgent))).rejects.toThrow("b broke");
    expect(started.toSorted()).toEqual(["a", "b", "c"]);
    expect(signals.filter((s) => s.aborted)).toHaveLength(3);
  });
});

describe("nested runs", () => {
  it("writes their own run.json and calls.jsonl, and rolls up into the parent", async () => {
    const { runAgent } = fakeAgent();
    let during: RunRecordBase | null = null;
    const child = defineFlow("child", async (id: string, ctx) => {
      during = await readJson<RunRecordBase>(ctx.runDir.runJsonPath);
      await ctx.step("work", (c) => c.agent(task(id)));
      await ctx.write("note.txt", "hello");
      ctx.annotate({ id });
    });
    const root = defineFlow("root", async (_: null, ctx) => {
      await ctx.agent(task("own"));
      await ctx.run(child, "x", { name: "case:x", dir: { root: "x", meta: { kind: "case" } } });
    });
    await startRun(root, null, options(runAgent));

    const childDir = path.join(dir.root, "x");
    expect(during).toMatchObject({ format: 2, kind: "case", status: "running" });
    await stat(path.join(childDir, "prompts", "x.md"));
    expect(await readFile(path.join(childDir, "note.txt"), "utf8")).toBe("hello");
    const childRun = await readJson<RunRecordBase>(path.join(childDir, "run.json"));
    expect(childRun).toMatchObject({
      kind: "case",
      id: "x",
      status: "ok",
      totals: { calls: 1, costUsd: 0.5 },
      flow: { name: "case:x", children: [expect.objectContaining({ name: "work" })] },
    });
    expect((await readCalls(path.join(childDir, "calls.jsonl"))).map((c) => c.path)).toEqual([
      "case:x/work",
    ]);
    expect((await readCalls(dir.callsPath)).map((c) => c.taskId)).toEqual(["own"]);

    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    expect(run.totals).toMatchObject({ calls: 2, costUsd: 1 });
    expect(run.flow?.children).toEqual([
      expect.objectContaining({ name: "case:x", totals: expect.objectContaining({ calls: 1 }) }),
    ]);
  });

  it("records a detached subtree but leaves it out of the totals and per-path views", async () => {
    const { runAgent } = fakeAgent();
    const side = defineFlow("side", async (_: null, ctx) => {
      await ctx.agent(task("side"));
    });
    const root = defineFlow("root", async (_: null, ctx) => {
      await ctx.step("main", (c) => c.agent(task("main")));
      await ctx.run(side, null, { detached: true });
    });
    await startRun(root, null, options(runAgent));

    expect((await readCalls(dir.callsPath)).map((c) => c.path)).toEqual(["root/main", "root/side"]);
    await stat(dir.promptPath("side"));
    const run = await readJson<RunRecordBase>(dir.runJsonPath);
    expect(run.totals).toMatchObject({ calls: 1, costUsd: 0.5 });
    expect(run.flow?.children).toEqual([
      expect.objectContaining({ name: "main" }),
      expect.objectContaining({
        name: "side",
        detached: true,
        totals: expect.objectContaining({ calls: 1 }),
      }),
    ]);
    expect([...flattenTree(run.flow).keys()]).toEqual(["main"]);
  });

  it("runs a subtree on another harness and with its own afterCall", async () => {
    const main = fakeAgent();
    const other = fakeAgent();
    const checked: string[] = [];
    const judge = defineFlow("judge", async (_: null, ctx) => {
      await ctx.agent(task("judged"));
    });
    const root = defineFlow("root", async (_: null, ctx) => {
      await ctx.agent(task("main"));
      await ctx.run(judge, null, {
        agent: { runAgent: other.runAgent, harness: "other" },
        afterCall: async (c) => void checked.push(c.taskId),
      });
    });
    await startRun(root, null, options(main.runAgent));
    expect(main.tasks.map((t) => t.taskId)).toEqual(["main"]);
    expect(other.tasks.map((t) => t.taskId)).toEqual(["judged"]);
    expect(checked).toEqual(["judged"]);
    expect((await readCalls(dir.callsPath)).map((c) => c.harness)).toEqual(["fake", "other"]);
  });
});
