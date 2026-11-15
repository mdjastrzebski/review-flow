import type { AgentStatus, TokenUsage } from "./agent.ts";

/**
 * `reported`: the harness reported the cost. `computed`: tokens × the price table (prices.ts).
 * `unknown`: neither.
 */
export type CostSource = "reported" | "computed" | "unknown";

/** One model call (one agent task); a line of calls.jsonl. */
export interface CallRecord {
  taskId: string;
  role: string;
  /** The scope that made the call, e.g. `review/find/verify/verifier:F-001`. */
  path: string;
  harness: string;
  model: string | null;
  effort: string | null;
  status: AgentStatus;
  error: string | null;
  /** null when the harness reports no token counts. */
  usage: TokenUsage | null;
  costUsd: number | null;
  costSource: CostSource;
  startedAt: string;
  durationMs: number;
  /** Reads outside the repo that ran (cursor; see AgentResult). */
  outsideReads: string[];
}

export interface CallTotals {
  calls: number;
  /** Sum over calls with a cost; null when none has one. */
  costUsd: number | null;
  /** Calls without a cost. When above 0, `costUsd` is a lower bound. */
  unknownCostCalls: number;
  /** Sum over calls that reported tokens. */
  usage: TokenUsage;
}

/** Totals plus wall time; for parallel work, wall time is less than the sum of the calls. */
export interface TimedTotals extends CallTotals {
  durationMs: number;
}

export function sumCalls(calls: readonly CallRecord[]): CallTotals {
  const usage: TokenUsage = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  let costUsd: number | null = null;
  let unknownCostCalls = 0;
  for (const call of calls) {
    if (call.costUsd === null) unknownCostCalls++;
    else costUsd = (costUsd ?? 0) + call.costUsd;
    if (call.usage === null) continue;
    usage.input += call.usage.input;
    usage.cacheRead += call.usage.cacheRead;
    usage.cacheWrite += call.usage.cacheWrite;
    usage.output += call.usage.output;
  }
  return { calls: calls.length, costUsd, unknownCostCalls, usage };
}

export const EMPTY_TOTALS: TimedTotals = {
  calls: 0,
  costUsd: null,
  unknownCostCalls: 0,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  durationMs: 0,
};

export function addCallTotals(a: CallTotals, b: CallTotals): CallTotals {
  return {
    calls: a.calls + b.calls,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    unknownCostCalls: a.unknownCostCalls + b.unknownCostCalls,
    usage: {
      input: a.usage.input + b.usage.input,
      cacheRead: a.usage.cacheRead + b.usage.cacheRead,
      cacheWrite: a.usage.cacheWrite + b.usage.cacheWrite,
      output: a.usage.output + b.usage.output,
    },
  };
}

/** Sums two totals, such as one step across eval cases. */
export function addTotals(a: TimedTotals, b: TimedTotals): TimedTotals {
  return { ...addCallTotals(a, b), durationMs: a.durationMs + b.durationMs };
}

/** One scope of a run: a flow (`ctx.run`) or a step inside one (`ctx.step`). */
export interface FlowNode {
  name: string;
  kind: "flow" | "step";
  /**
   * `failed`: threw its own error; `aborted`: stopped because a sibling or an ancestor failed.
   * `running` only in a live snapshot, never in a written record.
   */
  status: "ok" | "failed" | "aborted" | "running";
  error: string | null;
  startedAt: string;
  /** Wall time. */
  durationMs: number;
  /** This node's calls and all its descendants'. */
  totals: CallTotals;
  /** In start order. */
  children: FlowNode[];
  /** Recorded but not counted in the parent's totals or per-path views (`ctx.run` option). */
  detached?: true;
}

/** run.json; domain fields (the run's inputs) are spread at the top level next to these. */
export interface RunRecordBase {
  /** Marks this record format; runs without it use the older flat `steps`. */
  format: 2;
  /** The running process, while `running`; a dead pid means it was killed. */
  pid?: number;
  startedAt: string;
  /** null while running. */
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  error: string | null;
  totals: TimedTotals;
  /** null while running. */
  flow: FlowNode | null;
}

export const RECORD_FORMAT = 2 as const;

/** A node's totals with its wall time. */
export function timedTotals(node: FlowNode): TimedTotals {
  return { ...node.totals, durationMs: node.durationMs };
}

/** The node at a slash-joined path below `root` (`find/verify`), or undefined. */
export function findNode(root: FlowNode | null, nodePath: string): FlowNode | undefined {
  let node: FlowNode | undefined = root ?? undefined;
  for (const name of nodePath.split("/")) {
    node = node?.children.find((c) => c.name === name);
  }
  return node;
}

/** A name like `verifier:F-001` or `case:x`: one of many runs of the same flow. */
const isInstance = (name: string) => name.includes(":");

/**
 * Totals per slash-joined path below `root`, in start order, e.g. `find` and `find/verify`.
 * Instance nodes (a colon in the name, such as `verifier:F-001`) are not listed; their children
 * count under the instance's parent path, summed across instances. So an eval's cases add up
 * per step. Detached nodes are left out.
 */
export function flattenTree(root: FlowNode | null): Map<string, TimedTotals> {
  const out = new Map<string, TimedTotals>();
  const visit = (node: FlowNode, prefix: string) => {
    for (const child of node.children) {
      if (child.detached === true) continue;
      if (isInstance(child.name)) {
        visit(child, prefix);
        continue;
      }
      const childPath = prefix === "" ? child.name : `${prefix}/${child.name}`;
      const previous = out.get(childPath);
      const totals = timedTotals(child);
      out.set(childPath, previous === undefined ? totals : addTotals(previous, totals));
      visit(child, childPath);
    }
  };
  if (root !== null) visit(root, "");
  return out;
}
