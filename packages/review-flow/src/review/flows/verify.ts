import type { AgentFailureReason } from "../../runtime/agent.ts";
import type { FlowContext } from "../../runtime/flow.ts";
import { applyVerdictRules } from "../rank.ts";
import { RUN_FILES } from "../run-dir.ts";
import { countVerdicts } from "../run-index.ts";
import { Verdict, type NormalizedFinding } from "../schemas.ts";
import { buildVerifierPrompt, verifierTaskId } from "../verify.ts";
import { runRole, type ReviewScope } from "./scope.ts";

export interface VerifyInput {
  scope: ReviewScope;
  findings: readonly NormalizedFinding[];
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
  const { scope, findings } = input;
  if (findings.length > 0) ctx.log(`Verifying ${findings.length} finding(s)…`);
  const verdicts = await ctx.map(
    findings,
    async (finding, _, c): Promise<[string, Verdict]> => [
      finding.id,
      await c.run(verifier, { scope, finding }, { name: `verifier:${finding.id}`, instance: true }),
    ],
    { concurrency: VERIFIER_CONCURRENCY, warmFirst: true },
  );
  const result = Object.fromEntries(verdicts);
  await ctx.writeFile(RUN_FILES.verdicts, result);
  if (findings.length > 0) {
    const counts = countVerdicts(result);
    ctx.log(
      `Verified: ${counts.confirmed} confirmed, ${counts.inconclusive} inconclusive, ${counts.refuted} refuted`,
    );
  }
  return result;
}

/** One fresh verifier session. An agent failure becomes an inconclusive verdict. */
async function verifier(
  input: { scope: ReviewScope; finding: NormalizedFinding },
  ctx: FlowContext,
): Promise<Verdict> {
  const { scope, finding } = input;
  const result = await runRole("verifier", ctx, scope, {
    taskId: verifierTaskId(finding),
    prompt: buildVerifierPrompt(finding, scope.change),
    schema: Verdict,
  });
  if (result.status === "failure") {
    ctx.warn(`${finding.id}: verifier failed (${result.reason}); marked inconclusive.`);
    return failedVerdict(finding, result);
  }
  return applyVerdictRules(result.output);
}

/**
 * Stand-in verdict for a verifier that produced no valid output, so every finding still has a
 * verdict. Inconclusive is the honest state: nobody checked the claim.
 */
export function failedVerdict(
  finding: NormalizedFinding,
  failure: { reason: AgentFailureReason; error: string },
): Verdict {
  return {
    verdict: "inconclusive",
    // Unverified, so the reviewer's own severity is all there is to rank by.
    severity: finding.severity,
    confidence: "low",
    fixCost: "small",
    evidence: [],
    summary: `Verification failed (${failure.reason}): ${failure.error}`,
    fix: {
      assessment: "not_applicable",
      detail: "Not assessed; verification failed.",
      betterFix: null,
    },
  };
}

export const VERIFIER_CONCURRENCY = 3;
