import path from "node:path";
import { readJsonOrNull } from "../runtime/json.ts";
import { loadReviewRun, readRunRecord, type LoadedRun } from "../review/compare.ts";
import type { RunRecord } from "../review/flows/review.ts";
import { evalRunPaths, type EvalRunRecord } from "./eval.ts";
import type { CaseResult } from "./score.ts";

export interface LoadedEval {
  kind: "eval";
  id: string;
  run: EvalRunRecord;
  cases: CaseResult[];
}

/** A review or eval run to compare; fails on runs from before the flow tree. */
export async function loadRun(root: string): Promise<LoadedRun | LoadedEval> {
  const run = await readRunRecord<RunRecord | EvalRunRecord>(root);
  if ("kind" in run && run.kind === "eval") {
    const cases = await readJsonOrNull<CaseResult[]>(evalRunPaths(root).casesPath);
    return { kind: "eval", id: path.basename(root), run, cases: cases ?? [] };
  }
  return loadReviewRun(root, run as RunRecord);
}
