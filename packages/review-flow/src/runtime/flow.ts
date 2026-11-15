import { writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { AgentCallTask, AgentResult, RunAgent } from "./agent.ts";
import { runAgentCall, type TaskActivity } from "./call.ts";
import { formatElapsed } from "./format.ts";
import { writeJson } from "./json.ts";
import {
  addCallTotals,
  EMPTY_TOTALS,
  RECORD_FORMAT,
  sumCalls,
  type CallRecord,
  type FlowNode,
  type RunRecordBase,
} from "./records.ts";
import { createRunDirAt, type RunDirBase } from "./run-dir.ts";

/**
 * A unit of work: any async function of an input and a context, composing child flows through
 * the context. Its node in the tree takes the function's name (`async function find(…)` → `find`)
 * unless the caller gives another; the name is part of the saved paths, so renaming it renames them.
 */
export type Flow<I, O> = (input: I, ctx: FlowContext) => Promise<O>;

/** The node name: the caller's, else the function's; an anonymous flow must be given one. */
function nodeName(flow: Flow<never, unknown>, name: string | undefined): string {
  const resolved = name ?? flow.name;
  if (resolved === "") throw new Error("An anonymous flow needs a name: pass `name` to run it.");
  return resolved;
}

/** Work timed before a flow started, such as collecting inputs before its run dir could exist. */
export interface TimedStep {
  name: string;
  startedAt: Date;
  durationMs: number;
}

export interface FlowContext {
  /** Aborted when this scope or an ancestor is aborted. */
  readonly signal: AbortSignal;
  /** Slash-joined path of this scope from its run's root, e.g. `review/find/verify`. */
  readonly path: string;
  /** The nearest run dir. */
  readonly runDir: RunDirBase;
  readonly verbose: boolean;
  log(message: string): void;
  /** A problem that doesn't stop the run. */
  warn(message: string): void;

  /** One agent call with bookkeeping. Task ids must be unique per run dir. */
  agent<T>(
    task: AgentCallTask<T>,
    opts?: { onFirstActivity?: () => void },
  ): Promise<AgentResult<T> & { call: CallRecord }>;

  /** Runs a child flow in its own scope (a `flow` node). */
  run<I, O>(flow: Flow<I, O>, input: I, opts?: RunOptions): Promise<O>;

  /** A logical step inside this flow (a `step` node): groups and times the work in fn. */
  step<T>(name: string, fn: (ctx: FlowContext) => Promise<T>): Promise<T>;

  /**
   * Runs named branches concurrently, each with a context whose signal aborts when another branch
   * throws. The first error is rethrown once all branches have settled.
   */
  parallel<T extends Record<string, (ctx: FlowContext) => Promise<unknown>>>(
    branches: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;

  /**
   * Bounded fan-out. A throw clears the queue, aborts in-flight items, and is rethrown once they
   * have settled. warmFirst: item 0 runs alone until its first agent activity (or its end), so its
   * request writes the shared prompt cache that the others then read.
   */
  map<T, R>(
    items: readonly T[],
    fn: (item: T, index: number, ctx: FlowContext) => Promise<R>,
    opts: { concurrency: number; warmFirst?: boolean },
  ): Promise<R[]>;

  /** Writes an artifact into the nearest run dir: JSON for objects, as is for strings. */
  write(name: string, data: unknown): Promise<string>;

  /** Merges fields into the nearest run's run.json, now and in its final record. */
  annotate(fields: Record<string, unknown>): void;

  /** This scope's node so far: its finished children and calls, and the time up to now. */
  snapshot(): FlowNode;
}

export interface RunOptions {
  /** Node name; default: the flow function's name. E.g. `verifier:F-001`. */
  name?: string;
  /**
   * Opens a nested run in this dir (relative to the current run dir, or absolute), whose parent
   * must exist: its own run.json, calls.jsonl, prompts/, and raw/. `meta` goes in its run.json.
   */
  dir?: string | { root: string; meta?: Record<string, unknown> };
  /** Recorded as this flow's first steps; its start is the first one's. */
  before?: readonly TimedStep[];
  /** Runs after each agent call in this subtree, after inherited ones. */
  afterCall?: (call: CallRecord) => Promise<void>;
  /** Agent calls in this subtree run on this harness instead, e.g. a judge on another one. */
  agent?: { runAgent: RunAgent; harness: string };
  /** Log lines of this subtree go here instead, e.g. indented under an eval case. */
  log?: (message: string) => void;
  /**
   * Records the subtree (its node, calls, prompts, and raw output) but leaves its calls out of
   * the ancestors' totals and of per-path views, e.g. scoring work that isn't the run's own cost.
   */
  detached?: boolean;
}

export interface StartRunOptions {
  /** Already created. */
  dir: RunDirBase;
  runAgent: RunAgent;
  harness: string;
  log: (message: string) => void;
  /** Default: `log`. */
  warn?: (message: string) => void;
  /** Live agent activity. Default: logged as `  [taskId 0:12] text`. */
  onActivity?: (activity: TaskActivity) => void;
  verbose?: boolean;
  /** Root node name; default: the flow function's name. */
  name?: string;
  /** Called after every agent call; a throw fails the call. */
  afterCall?: (call: CallRecord) => Promise<void>;
  /** Domain fields for run.json, spread next to the generic ones. */
  meta?: Record<string, unknown>;
  /** Recorded as the root's first steps; the run's start is the first one's. */
  before?: readonly TimedStep[];
  /** Called with the final record (ok or failed) once run.json is written. */
  onFinish?: (record: RunRecordBase & Record<string, unknown>) => Promise<void>;
}

/** A run dir and its run.json. */
interface Run {
  dir: RunDirBase;
  meta: Record<string, unknown>;
  startedAt: Date;
  /** run.json writes, in order. */
  writing: Promise<void>;
  finished: boolean;
}

/** A node being built. */
interface Scope {
  name: string;
  kind: "flow" | "step";
  path: string;
  startedAt: number;
  run: Run;
  calls: CallRecord[];
  children: (Scope | FlowNode)[];
  end: { status: FlowNode["status"]; error: string | null; durationMs: number } | null;
  detached: boolean;
}

/** What a scope passes down to its children. */
interface Env {
  signal: AbortSignal;
  runAgent: RunAgent;
  harness: string;
  afterCall: readonly ((call: CallRecord) => Promise<void>)[];
  /** Called on each agent activity in the subtree (warm-up). */
  onProgress: readonly (() => void)[];
  log: (message: string) => void;
  warn: (message: string) => void;
  onActivity: (activity: TaskActivity) => void;
  verbose: boolean;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isScope = (child: Scope | FlowNode): child is Scope => "calls" in child;

function snapshot(scope: Scope): FlowNode {
  const children = scope.children.map((c) => (isScope(c) ? snapshot(c) : c));
  return {
    name: scope.name,
    kind: scope.kind,
    status: scope.end?.status ?? "running",
    error: scope.end?.error ?? null,
    startedAt: new Date(scope.startedAt).toISOString(),
    durationMs: scope.end?.durationMs ?? Date.now() - scope.startedAt,
    totals: children
      .filter((c) => c.detached !== true)
      .reduce((sum, c) => addCallTotals(sum, c.totals), sumCalls(scope.calls)),
    children,
    ...(scope.detached ? { detached: true as const } : {}),
  };
}

function stepNode(step: TimedStep): FlowNode {
  return {
    name: step.name,
    kind: "step",
    status: "ok",
    error: null,
    startedAt: step.startedAt.toISOString(),
    durationMs: step.durationMs,
    totals: sumCalls([]),
    children: [],
  };
}

function newScope(
  name: string,
  kind: Scope["kind"],
  run: Run,
  parent: Scope | null,
  before: readonly TimedStep[] = [],
  detached = false,
): Scope {
  const scope: Scope = {
    name,
    kind,
    // Paths start at the run's root, so calls.jsonl matches the tree in the same run.json.
    path: parent === null || parent.run !== run ? name : `${parent.path}/${name}`,
    startedAt: before[0]?.startedAt.getTime() ?? Date.now(),
    run,
    calls: [],
    children: before.map(stepNode),
    end: null,
    detached,
  };
  parent?.children.push(scope);
  return scope;
}

/** Runs fn in the scope, then records how the scope ended. */
async function enter<T>(scope: Scope, env: Env, fn: (ctx: FlowContext) => Promise<T>): Promise<T> {
  try {
    const result = await fn(contextOf(scope, env));
    scope.end = { status: "ok", error: null, durationMs: Date.now() - scope.startedAt };
    return result;
  } catch (error) {
    scope.end = {
      status: env.signal.aborted ? "aborted" : "failed",
      error: errorMessage(error),
      durationMs: Date.now() - scope.startedAt,
    };
    throw error;
  }
}

function writeRecord(run: Run, record: RunRecordBase): Promise<void> {
  const write = run.writing.then(() => writeJson(run.dir.runJsonPath, record));
  // A failed write doesn't block the next; the caller awaiting `write` sees it.
  run.writing = write.catch(() => {});
  return write;
}

function runningRecord(run: Run): RunRecordBase {
  return {
    format: RECORD_FORMAT,
    ...run.meta,
    pid: process.pid,
    startedAt: run.startedAt.toISOString(),
    finishedAt: null,
    status: "running",
    error: null,
    totals: EMPTY_TOTALS,
    flow: null,
  };
}

/** Writes run.json as `running`, runs body, then writes the final record, failed or not. */
async function withRun<T>(
  run: Run,
  root: Scope,
  body: () => Promise<T>,
  onFinish?: StartRunOptions["onFinish"],
): Promise<T> {
  await writeRecord(run, runningRecord(run));
  let failure: string | null = null;
  try {
    return await body();
  } catch (error) {
    failure = errorMessage(error);
    throw error;
  } finally {
    run.finished = true;
    const finishedAt = new Date();
    const flow = snapshot(root);
    const record = {
      format: RECORD_FORMAT,
      ...run.meta,
      startedAt: run.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: failure === null ? ("ok" as const) : ("failed" as const),
      error: failure,
      totals: { ...flow.totals, durationMs: finishedAt.getTime() - run.startedAt.getTime() },
      flow,
    };
    await writeRecord(run, record);
    await onFinish?.(record);
  }
}

async function runChild<I, O>(
  parent: Scope,
  env: Env,
  flow: Flow<I, O>,
  input: I,
  opts: RunOptions = {},
): Promise<O> {
  const childEnv: Env = {
    ...env,
    ...(opts.agent === undefined ? {} : opts.agent),
    ...(opts.log === undefined ? {} : { log: opts.log }),
    afterCall: opts.afterCall === undefined ? env.afterCall : [...env.afterCall, opts.afterCall],
  };
  const name = nodeName(flow, opts.name);
  const call = (ctx: FlowContext) => flow(input, ctx);
  if (opts.dir === undefined) {
    const scope = newScope(name, "flow", parent.run, parent, opts.before, opts.detached);
    return enter(scope, childEnv, call);
  }
  const { root, meta = {} } = typeof opts.dir === "string" ? { root: opts.dir } : opts.dir;
  const dir = await createRunDirAt(path.resolve(parent.run.dir.root, root));
  const run: Run = {
    dir,
    meta: { ...meta },
    startedAt: opts.before?.[0]?.startedAt ?? new Date(),
    writing: Promise.resolve(),
    finished: false,
  };
  const scope = newScope(name, "flow", run, parent, opts.before, opts.detached);
  return withRun(run, scope, () => enter(scope, childEnv, call));
}

function contextOf(scope: Scope, env: Env): FlowContext {
  const ctx: FlowContext = {
    signal: env.signal,
    path: scope.path,
    runDir: scope.run.dir,
    verbose: env.verbose,
    log: env.log,
    warn: env.warn,

    agent(task, opts) {
      let active = false;
      return runAgentCall(
        { ...task, signal: task.signal ?? env.signal },
        {
          runDir: scope.run.dir,
          path: scope.path,
          harness: env.harness,
          runAgent: env.runAgent,
          log: env.log,
          onActivity: env.onActivity,
          verbose: env.verbose,
          onCall: (call) => scope.calls.push(call),
          ...(env.afterCall.length === 0
            ? {}
            : {
                afterCall: async (call) => {
                  for (const check of env.afterCall) await check(call);
                },
              }),
        },
        () => {
          if (!active) opts?.onFirstActivity?.();
          active = true;
          for (const listener of env.onProgress) listener();
        },
      );
    },

    run: (flow, input, opts) => runChild(scope, env, flow, input, opts),

    step: (name, fn) => enter(newScope(name, "step", scope.run, scope), env, fn),

    async parallel(branches) {
      const own = new AbortController();
      const branchCtx = contextOf(scope, {
        ...env,
        signal: AbortSignal.any([env.signal, own.signal]),
      });
      // The first error thrown, which stops the other branches.
      const errors: unknown[] = [];
      const entries = Object.entries(branches);
      const settled = await Promise.allSettled(
        entries.map(([, fn]) =>
          fn(branchCtx).catch((error: unknown) => {
            errors.push(error);
            own.abort(error);
            throw error;
          }),
        ),
      );
      if (errors.length > 0) throw errors[0];
      return Object.fromEntries(
        entries.map(([key], i) => [key, (settled[i] as PromiseFulfilledResult<unknown>).value]),
      ) as never;
    },

    async map(items, fn, { concurrency, warmFirst = false }) {
      const warm = Promise.withResolvers<void>();
      if (!warmFirst) warm.resolve();
      // rejectOnClear: otherwise cleared items never settle and allSettled hangs.
      const limit = pLimit({ concurrency, rejectOnClear: true });
      const own = new AbortController();
      const signal = AbortSignal.any([env.signal, own.signal]);
      const itemEnv: Env = { ...env, signal };
      const firstEnv: Env = { ...itemEnv, onProgress: [...env.onProgress, warm.resolve] };
      // The first thrown error, in the order thrown; cleared items reject later with AbortErrors.
      const errors: unknown[] = [];
      const settled = await Promise.allSettled(
        items.map((item, index) =>
          limit(async () => {
            try {
              if (index > 0) {
                await warm.promise;
                if (signal.aborted) throw signal.reason;
              }
              const result = await fn(
                item,
                index,
                contextOf(scope, index === 0 ? firstEnv : itemEnv),
              );
              warm.resolve();
              return result;
            } catch (error) {
              errors.push(error);
              limit.clearQueue();
              own.abort();
              // After the abort, so waiting items see it and don't start.
              warm.resolve();
              throw error;
            }
          }),
        ),
      );
      if (errors.length > 0) throw errors[0];
      return settled.map(
        (s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof fn>>>).value,
      );
    },

    async write(name, data) {
      const file = scope.run.dir.path(name);
      if (typeof data === "string") await writeFile(file, data);
      else await writeJson(file, data);
      return file;
    },

    annotate(fields) {
      Object.assign(scope.run.meta, fields);
      if (!scope.run.finished) void writeRecord(scope.run, runningRecord(scope.run));
    },

    snapshot: () => snapshot(scope),
  };
  return ctx;
}

/**
 * Runs a flow as the root of a run: run.json is written as `running` (with the pid) at the
 * start, and with the final status and flow tree at the end, also when the flow throws.
 */
export function startRun<I, O>(flow: Flow<I, O>, input: I, options: StartRunOptions): Promise<O> {
  const { log } = options;
  const run: Run = {
    dir: options.dir,
    meta: { ...options.meta },
    startedAt: options.before?.[0]?.startedAt ?? new Date(),
    writing: Promise.resolve(),
    finished: false,
  };
  const env: Env = {
    signal: new AbortController().signal,
    runAgent: options.runAgent,
    harness: options.harness,
    afterCall: options.afterCall === undefined ? [] : [options.afterCall],
    onProgress: [],
    log,
    warn: options.warn ?? log,
    onActivity:
      options.onActivity ?? ((a) => log(`  [${a.taskId} ${formatElapsed(a.elapsedMs)}] ${a.text}`)),
    verbose: options.verbose ?? false,
  };
  const root = newScope(nodeName(flow, options.name), "flow", run, null, options.before);
  return withRun(run, root, () => enter(root, env, (ctx) => flow(input, ctx)), options.onFinish);
}
