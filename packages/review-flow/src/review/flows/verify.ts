import type { AgentStatus } from "../../runtime/agent.ts";
import type { FlowContext } from "../../runtime/flow.ts";
import type { RoleModels } from "../models.ts";
import { loadPrompt } from "../prompts.ts";
import { applyVerdictRules } from "../rank.ts";
import { RUN_FILES } from "../run-dir.ts";
import { countVerdicts } from "../run-index.ts";
import { Verdict, type NormalizedFinding } from "../schemas.ts";
import { buildVerifierPrompt, verifierTaskId, type ChangeRange } from "../verify.ts";

export const VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;
export const VERIFIER_CONCURRENCY = 3;

/**
 * Stand-in verdict for a verifier that produced no valid output, so every finding still has a
 * verdict. Inconclusive is the honest state: nobody checked the claim.
 */
export function failedVerdict(
  finding: NormalizedFinding,
  status: AgentStatus,
  error: string | null,
): Verdict {
  return {
    verdict: "inconclusive",
    // Unverified, so the reviewer's own severity is all there is to rank by.
    severity: finding.severity,
    confidence: "low",
    fixCost: "small",
    evidence: [],
    summary: `Verification failed (${status}): ${error ?? "no output"}`,
    fix: {
      assessment: "not_applicable",
      detail: "Not assessed; verification failed.",
      betterFix: null,
    },
  };
}

export interface VerifyInput {
  repo: string;
  findings: readonly NormalizedFinding[];
  change: ChangeRange;
  sharedContext: string;
  models: Pick<RoleModels, "verifier">;
}

interface VerifierInput extends Omit<VerifyInput, "findings"> {
  finding: NormalizedFinding;
  template: string;
}

/** One fresh verifier session. An agent failure becomes an inconclusive verdict. */
async function verifier(input: VerifierInput, ctx: FlowContext): Promise<Verdict> {
  const { finding } = input;
  const result = await ctx.agent({
    taskId: verifierTaskId(finding),
    role: "verifier",
    prompt: buildVerifierPrompt(input.template, finding, input.change),
    sharedContext: input.sharedContext,
    cwd: input.repo,
    schema: Verdict,
    model: input.models.verifier.model,
    effort: input.models.verifier.effort,
    timeoutMs: VERIFIER_TIMEOUT_MS,
  });
  if (result.output === null) {
    ctx.warn(`${finding.id}: verifier failed (${result.status}); marked inconclusive.`);
    return failedVerdict(finding, result.status, result.error);
  }
  return applyVerdictRules(result.output);
}

/**
 * One verifier per finding, at most VERIFIER_CONCURRENCY at a time; anything thrown (e.g. the
 * working tree changed) stops queued ones and aborts in-flight ones. The first runs alone until it
 * shows activity: by then its request has written the shared diff to the prompt cache, so the
 * others read it instead of each writing it again; a cache write costs about 40× a cache read.
 * Writes verdicts.json.
 */
export async function verify(
  input: VerifyInput,
  ctx: FlowContext,
): Promise<Record<string, Verdict>> {
  const { findings } = input;
  if (findings.length > 0) ctx.log(`Verifying ${findings.length} finding(s)…`);
  const template = await loadPrompt("verifier");
  const verdicts = await ctx.map(
    findings,
    async (finding, _, c): Promise<[string, Verdict]> => [
      finding.id,
      await c.run(verifier, { ...input, finding, template }, { name: `verifier:${finding.id}` }),
    ],
    { concurrency: VERIFIER_CONCURRENCY, warmFirst: true },
  );
  const result = Object.fromEntries(verdicts);
  await ctx.write(RUN_FILES.verdicts, result);
  if (findings.length > 0) {
    const counts = countVerdicts(result);
    ctx.log(
      `Verified: ${counts.confirmed} confirmed, ${counts.inconclusive} inconclusive, ${counts.refuted} refuted`,
    );
  }
  return result;
}
