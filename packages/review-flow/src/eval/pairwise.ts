import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunAgent } from "../runtime/agent.ts";
import { checkoutName, type EvalCase } from "./dataset.ts";
import { evalRunPaths } from "./eval.ts";
import type { CaseResult } from "./score.ts";
import { checkoutDetached, ensureClone } from "../review/git.ts";
import { readJsonOrNull, writeJson } from "../runtime/json.ts";
import type { ModelChoice } from "../review/models.ts";
import { renderPrompt } from "../review/prompts.ts";
import { describeRoughEdges, keptRoughEdges } from "../review/rough-edges.ts";
import { runDirPaths } from "../review/run-dir.ts";
import type { CheckedRoughEdge } from "../review/schemas.ts";
import { buildChangeContext, changeRangeOf, type ChangeRange } from "../review/verify.ts";

export interface PairwiseOptions {
  a: { root: string; cases: readonly CaseResult[] };
  b: { root: string; cases: readonly CaseResult[] };
  /** The dataset's cases, for each case's repo and commits. */
  dataset: readonly EvalCase[];
  checkoutsDir: string;
  model: ModelChoice;
  runAgent: RunAgent;
  log: (message: string) => void;
  warn?: (message: string) => void;
  random?: () => number;
}

/** pairwise-<B's id>.json in eval A's run dir. */
export interface PairwiseRecord {
  judgedAt: string;
  a: string;
  b: string;
  judge: ModelChoice;
  cases: PairwiseCase[];
  scores: PairwiseScores;
}

/** One case judged pairwise; `winner` is null when the judge failed. */
export interface PairwiseCase {
  id: string;
  winner: "a" | "b" | "tie" | null;
  /** Whether eval A's set was shown first, as Set 1. */
  aFirst: boolean;
  reason: string | null;
  error: string | null;
  /** Rough edges kept by each eval's checker, as compared. */
  kept: { a: number; b: number };
  costUsd: number | null;
  durationMs: number;
}

export interface PairwiseScores {
  /** Cases judged; failed ones are counted apart. */
  cases: number;
  failed: number;
  aWins: number;
  bWins: number;
  ties: number;
  /** B's wins plus half the ties, of the cases judged; null when none was. */
  bWinRate: number | null;
  /** Sum of the judge calls; null when none has a cost. */
  costUsd: number | null;
}

/**
 * Judges two evals' rough edges pairwise, case by case: only cases both ran with rough edges and
 * finished. Each is judged in its checkout, at the case head, one at a time since cases share
 * clones. The result goes in eval A's run dir as `pairwise-<B's id>.json`.
 */
export async function pairwiseEvals(options: PairwiseOptions): Promise<PairwiseRecord> {
  const dataset = new Map(options.dataset.map((c) => [c.id, c]));
  const inB = new Map(options.b.cases.map((c) => [c.id, c]));
  const both = options.a.cases.filter((c) => {
    const other = inB.get(c.id);
    return (
      c.status === "ok" &&
      c.roughEdges != null &&
      other?.status === "ok" &&
      other.roughEdges != null
    );
  });
  if (both.length === 0) throw new Error("No case ran with rough edges in both evals.");
  const [pathsA, pathsB] = [evalRunPaths(options.a.root), evalRunPaths(options.b.root)];
  const results: PairwiseCase[] = [];
  for (const [index, { id }] of both.entries()) {
    const evalCase = dataset.get(id);
    const [a, b] = await Promise.all([keptOf(pathsA.caseRoot(id)), keptOf(pathsB.caseRoot(id))]);
    if (evalCase === undefined || a === null || b === null) {
      options.warn?.(
        `${id}: ${evalCase === undefined ? "not in the dataset" : "no rough edges saved"}; skipped.`,
      );
      continue;
    }
    const checkout = path.join(options.checkoutsDir, checkoutName(evalCase.repo));
    const startedAt = Date.now();
    let result: PairwiseCase;
    try {
      await ensureClone(evalCase.repo, checkout, [evalCase.base, evalCase.head]);
      await checkoutDetached(checkout, evalCase.head);
      result = await judgePair({
        caseId: id,
        a,
        b,
        change: changeRangeOf(evalCase.base, { uncommitted: false }),
        diff: await readFile(runDirPaths(pathsA.caseRoot(id)).diffPath, "utf8"),
        cwd: checkout,
        model: options.model,
        runAgent: options.runAgent,
        ...(options.random === undefined ? {} : { random: options.random }),
      });
    } catch (caught) {
      // A failed setup fails the case, not the cases already judged and paid for.
      result = {
        id,
        winner: null,
        aFirst: false,
        reason: null,
        error: caught instanceof Error ? caught.message : String(caught),
        kept: { a: a.length, b: b.length },
        costUsd: null,
        durationMs: Date.now() - startedAt,
      };
    }
    results.push(result);
    if (result.winner === null)
      options.warn?.(`${id}: the pairwise judge failed (${result.error}).`);
    options.log(`[${index + 1}/${both.length}] ${id}: ${result.winner ?? "failed"}`);
  }
  const record: PairwiseRecord = {
    judgedAt: new Date().toISOString(),
    a: options.a.root,
    b: options.b.root,
    judge: options.model,
    cases: results,
    scores: summarizePairwise(results),
  };
  await writeJson(
    path.join(options.a.root, `pairwise-${path.basename(options.b.root)}.json`),
    record,
  );
  return record;
}

/** Rough edges a case kept, from its run dir; null when it has none saved. */
async function keptOf(caseRoot: string): Promise<CheckedRoughEdge[] | null> {
  const edges = await readJsonOrNull<CheckedRoughEdge[]>(runDirPaths(caseRoot).roughEdgesPath);
  return edges === null ? null : keptRoughEdges(edges);
}

/**
 * Asks which of two sets of rough edges the judge would rather post, blind: the sets are shown in
 * a random order, under neutral names. Two empty sets are a tie without a call.
 */
export async function judgePair(options: {
  caseId: string;
  a: readonly CheckedRoughEdge[];
  b: readonly CheckedRoughEdge[];
  change: ChangeRange;
  diff: string;
  cwd: string;
  model: ModelChoice;
  runAgent: RunAgent;
  random?: () => number;
}): Promise<PairwiseCase> {
  const { a, b } = options;
  const aFirst = (options.random ?? Math.random)() < 0.5;
  const base = { id: options.caseId, aFirst, kept: { a: a.length, b: b.length } };
  if (a.length === 0 && b.length === 0) {
    return {
      ...base,
      winner: "tie",
      reason: "Both sets are empty.",
      error: null,
      costUsd: 0,
      durationMs: 0,
    };
  }
  const [first, second] = aFirst ? [a, b] : [b, a];
  const result = await options.runAgent({
    taskId: `judge-pairwise-${options.caseId}`,
    role: "judge",
    prompt: renderPrompt("rough-edge-pairwise", {
      ...options.change,
      set1: describeSet(first),
      set2: describeSet(second),
    }),
    sharedContext: buildChangeContext(options.change, options.diff),
    cwd: options.cwd,
    schema: PairwiseOutput,
    model: options.model.model,
    effort: options.model.effort,
    timeoutMs: PAIRWISE_TIMEOUT_MS,
    onProgress: () => {},
  });
  const call = { costUsd: result.costUsd, durationMs: result.durationMs };
  if (result.status === "failure") {
    return { ...base, ...call, winner: null, reason: null, error: result.error };
  }
  const { preferred, reason } = result.output;
  const winner = preferred === "tie" ? "tie" : (preferred === "1") === aFirst ? "a" : "b";
  return { ...base, ...call, winner, reason, error: null };
}

const describeSet = (edges: readonly CheckedRoughEdge[]) =>
  edges.length === 0 ? emptySet : describeRoughEdges(edges);

const emptySet = "(no rough edges)";

export const PairwiseOutput = z.strictObject({
  reason: z.string(),
  preferred: z.enum(["1", "2", "tie"]),
});

export type PairwiseOutput = z.infer<typeof PairwiseOutput>;

const PAIRWISE_TIMEOUT_MS = 10 * 60_000;

export function summarizePairwise(cases: readonly PairwiseCase[]): PairwiseScores {
  const judged = cases.filter((c) => c.winner !== null);
  const count = (winner: PairwiseCase["winner"]) =>
    judged.filter((c) => c.winner === winner).length;
  const [aWins, bWins, ties] = [count("a"), count("b"), count("tie")];
  const costs = cases.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]));
  return {
    cases: judged.length,
    failed: cases.length - judged.length,
    aWins,
    bWins,
    ties,
    bWinRate: judged.length === 0 ? null : (bWins + ties / 2) / judged.length,
    costUsd: costs.length === 0 ? null : costs.reduce((x, y) => x + y, 0),
  };
}
