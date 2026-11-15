import { describeFailure } from "../../runtime/agent.ts";
import type { FlowContext } from "../../runtime/flow.ts";
import { normalizeFindings, normalizeRoughEdges } from "../normalize.ts";
import { codeFence, loadPrompt, renderPrompt } from "../prompts.ts";
import { RUN_FILES } from "../run-dir.ts";
import { countVerdicts, type VerdictCounts } from "../run-index.ts";
import {
  FindingsOutput,
  lenientReviewOutput,
  type CheckedRoughEdge,
  type NormalizedFinding,
  type ReviewOutput,
  type Verdict,
} from "../schemas.ts";
import { checkRoughEdges } from "./check-rough-edges.ts";
import { runRole, type ReviewScope } from "./scope.ts";
import { verify } from "./verify.ts";

export interface FindInput {
  scope: ReviewScope;
  diff: string;
  /** Ask the reviewer for rough edges and check them. */
  roughEdges: boolean;
  /** The reviewer's finding count, once findings.json is written; for the run index. */
  onFindings?: ((count: number) => void) | undefined;
  /** The verdict counts, once verification is done; for the run index. */
  onVerdicts?: ((counts: VerdictCounts) => void) | undefined;
}

export interface FindResult {
  findings: NormalizedFinding[];
  /** findingId → verdict, with the code-enforced rules applied. */
  verdicts: Record<string, Verdict>;
  /** Checked rough edges, `inaccurate` ones included; empty when not asked for. */
  roughEdges: CheckedRoughEdge[];
}

/**
 * Find: the reviewer (step `review`; a failure stops the run), then a verifier per finding, then
 * the batched rough edge check (its own node, so its cost shows apart). rough-edges.json is
 * written only when rough edges were asked for.
 */
export async function find(input: FindInput, ctx: FlowContext): Promise<FindResult> {
  const { scope } = input;
  const { repo } = scope;
  const { findings, edges } = await ctx.step("review", async (c) => {
    const prompt = renderPrompt(await loadPrompt("reviewer"), {
      ...scope.change,
      diffBlock: codeFence(input.diff, "diff"),
      roughEdges: input.roughEdges ? await loadPrompt("rough-edges") : "",
    });
    c.log("Reviewing…");
    const lenient = input.roughEdges ? lenientReviewOutput() : null;
    const review = await runRole<FindingsOutput | ReviewOutput>(c, scope, "reviewer", {
      taskId: "reviewer",
      prompt,
      // The diff is in the prompt: the reviewer is the only task of its role.
      sharedContext: null,
      schema: lenient?.schema ?? FindingsOutput,
    });
    if (review.status === "failure")
      throw new Error(`Reviewer failed (${describeFailure(review)})`);

    for (const note of lenient?.notes() ?? []) c.log(note);
    const normalized = normalizeFindings(review.output, repo);
    for (const note of normalized.notes) c.log(note);
    await c.writeFile(RUN_FILES.findings, normalized.findings);
    c.log(`Reviewer returned ${normalized.findings.length} finding(s)`);
    // Present exactly when rough edges are on: the schema above asks for them.
    const roughEdges =
      "roughEdges" in review.output ? normalizeRoughEdges(review.output.roughEdges, repo) : null;
    for (const note of roughEdges?.notes ?? []) c.log(note);
    if (roughEdges !== null)
      c.log(`Reviewer returned ${roughEdges.roughEdges.length} rough edge(s)`);
    return { findings: normalized.findings, edges: roughEdges?.roughEdges ?? null };
  });
  input.onFindings?.(findings.length);
  ctx.signal.throwIfAborted();

  const verdicts = await ctx.run(verify, { scope, findings });
  let roughEdges: CheckedRoughEdge[] = [];
  if (edges !== null) {
    if (edges.length > 0)
      roughEdges = await ctx.run(checkRoughEdges, { scope, edges }, { name: "check" });
    await ctx.writeFile(RUN_FILES.roughEdges, roughEdges);
  }
  input.onVerdicts?.(countVerdicts(verdicts));
  return { findings, verdicts, roughEdges };
}
