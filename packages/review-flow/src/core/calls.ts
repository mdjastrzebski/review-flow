import type { AgentStatus, TokenUsage } from "./agent.ts";
import type { Effort, Harness, Role } from "./models.ts";

/** Pipeline steps that are timed. Ranking runs inside verify (rules) and report (sort). */
export type Step = "collect" | "summarize" | "review" | "verify" | "report";

/**
 * `reported`: the harness reported the cost. `computed`: tokens × the price table (prices.ts).
 * `unknown`: neither.
 */
export type CostSource = "reported" | "computed" | "unknown";

/** One model call (one agent task); a line of calls.jsonl. */
export interface CallRecord {
  taskId: string;
  role: Role;
  step: Step;
  harness: Harness;
  model: string | null;
  effort: Effort | null;
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

/** Totals plus wall time; for verify, wall time is less than the sum of parallel calls. */
export interface TimedTotals extends CallTotals {
  durationMs: number;
}

export function sumCalls(calls: readonly CallRecord[]): CallTotals {
  const usage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
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

/** Per-step and per-run totals for run.json, in the order the steps ran. */
export function rollUp(
  calls: readonly CallRecord[],
  stepDurations: ReadonlyMap<Step, number>,
  durationMs: number,
): { steps: Partial<Record<Step, TimedTotals>>; totals: TimedTotals } {
  const steps: Partial<Record<Step, TimedTotals>> = {};
  for (const [step, stepMs] of stepDurations) {
    steps[step] = { ...sumCalls(calls.filter((c) => c.step === step)), durationMs: stepMs };
  }
  return { steps, totals: { ...sumCalls(calls), durationMs } };
}

export const EMPTY_TOTALS: TimedTotals = {
  calls: 0,
  costUsd: null,
  unknownCostCalls: 0,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  durationMs: 0,
};

/** Sums two totals, such as one step across eval cases. */
export function addTotals(a: TimedTotals, b: TimedTotals): TimedTotals {
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
    durationMs: a.durationMs + b.durationMs,
  };
}
