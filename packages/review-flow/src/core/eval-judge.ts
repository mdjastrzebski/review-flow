import { z } from "zod";
import type { RunAgent } from "./agent.ts";
import type { EvalCase } from "./eval-dataset.ts";
import type { ModelChoice } from "./models.ts";
import { MAX_FIX_DIFF_CHARS } from "./eval-fixes.ts";
import { codeFence, loadPrompt, renderPrompt } from "./prompts.ts";
import type { NormalizedFinding } from "./schemas.ts";

const JUDGE_TIMEOUT_MS = 5 * 60_000;
/** Keeps a long rationale from dominating the prompt; the claim says what the finding asserts. */
const MAX_RATIONALE_CHARS = 1200;

export const JudgeOutput = z.strictObject({
  bugs: z.array(
    z.strictObject({
      /** Position in the case's `bugs`, from 0. */
      bug: z.int().nonnegative(),
      matches: z.array(z.strictObject({ finding: z.string(), reason: z.string() })),
    }),
  ),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export type JudgeResult =
  | {
      status: "ok";
      /** Bug index to the ids of the findings that describe it. */
      matches: Map<number, Set<string>>;
      output: JudgeOutput;
      costUsd: number | null;
      durationMs: number;
    }
  | { status: "failed"; error: string; costUsd: number | null; durationMs: number };

function describeBugs(bugs: EvalCase["bugs"], fixDiffs: readonly (string | null)[]): string {
  return bugs
    .map((bug, index) => {
      const where = bug.locations.map((l) => `${l.file}:${l.start}-${l.end}`).join(", ");
      const head = `${index}. ${bug.description}\n   Where: ${where}\n   Fix: ${bug.fix}`;
      const diff = fixDiffs[index];
      if (diff === null || diff === undefined) return head;
      const shown =
        diff.length > MAX_FIX_DIFF_CHARS
          ? `${diff.slice(0, MAX_FIX_DIFF_CHARS)}\n… [truncated]`
          : diff;
      return `${head}\n   What the fix changed (the defect is the flaw it removes or corrects):\n\n${codeFence(shown, "diff")}`;
    })
    .join("\n\n");
}

function describeFindings(findings: readonly NormalizedFinding[]): string {
  const items = findings.map((f) => ({
    id: f.id,
    location: `${f.file}:${f.lineStart}-${f.lineEnd}`,
    title: f.title,
    claim: f.claim,
    rationale:
      f.rationale.length > MAX_RATIONALE_CHARS
        ? `${f.rationale.slice(0, MAX_RATIONALE_CHARS)}…`
        : f.rationale,
  }));
  return codeFence(JSON.stringify(items, null, 2), "json");
}

export function buildJudgePrompt(
  template: string,
  evalCase: Pick<EvalCase, "title" | "bugs">,
  findings: readonly NormalizedFinding[],
  fixDiffs: readonly (string | null)[] = [],
): string {
  return renderPrompt(template, {
    case: evalCase.title,
    bugs: describeBugs(evalCase.bugs, fixDiffs),
    findings: describeFindings(findings),
  });
}

/** Unknown bug indexes and finding ids are dropped: the judge can only match what exists. */
export function matchesOf(
  output: JudgeOutput,
  bugCount: number,
  findings: readonly NormalizedFinding[],
): Map<number, Set<string>> {
  const known = new Set(findings.map((f) => f.id));
  const matches = new Map<number, Set<string>>();
  for (const entry of output.bugs) {
    if (entry.bug >= bugCount) continue;
    const ids = matches.get(entry.bug) ?? new Set<string>();
    for (const match of entry.matches) if (known.has(match.finding)) ids.add(match.finding);
    matches.set(entry.bug, ids);
  }
  return matches;
}

/**
 * Asks the judge which findings describe each known bug of a case. It reads `diff.patch` in
 * `cwd`, the case's run dir, and nothing else of the repo, so a finished run can be scored again
 * without its checkout.
 */
export async function judgeCase(options: {
  evalCase: Pick<EvalCase, "id" | "title" | "bugs">;
  findings: readonly NormalizedFinding[];
  /** The diff of each bug's fix PR, in order; null or absent for none. */
  fixDiffs?: readonly (string | null)[];
  cwd: string;
  model: ModelChoice;
  runAgent: RunAgent;
  signal?: AbortSignal;
}): Promise<JudgeResult> {
  const { evalCase, findings } = options;
  if (findings.length === 0) {
    return {
      status: "ok",
      matches: new Map(),
      output: { bugs: evalCase.bugs.map((_, bug) => ({ bug, matches: [] })) },
      costUsd: 0,
      durationMs: 0,
    };
  }
  const prompt = buildJudgePrompt(await loadPrompt("judge"), evalCase, findings, options.fixDiffs);
  const result = await options.runAgent({
    taskId: `judge-${evalCase.id}`,
    role: "judge",
    prompt,
    sharedContext: null,
    cwd: options.cwd,
    schema: JudgeOutput,
    model: options.model.model,
    effort: options.model.effort,
    timeoutMs: JUDGE_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: () => {},
  });
  if (result.status !== "ok" || result.output === null) {
    return {
      status: "failed",
      error: result.error ?? result.status,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
  }
  return {
    status: "ok",
    matches: matchesOf(result.output, evalCase.bugs.length, findings),
    output: result.output,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}
