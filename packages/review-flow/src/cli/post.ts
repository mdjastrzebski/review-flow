import { readFile } from "node:fs/promises";
import { styleText } from "node:util";
import {
  buildReview,
  currentPrHead,
  formatLocation,
  postableItems,
  postReview,
  readJsonOrNull,
  runDirPaths,
  writeJson,
  type NormalizedFinding,
  type PostedRecord,
  type RunRecord,
  type Verdict,
} from "../core/index.ts";
import { ask, confirm, interactive, parseSelection } from "./prompt.ts";

type Paint = (style: Parameters<typeof styleText>[0], text: string) => string;

/**
 * Posts selected findings of a PR run as one COMMENT review: select, check the PR head, preview,
 * confirm, send. Needs a TTY; nothing is posted without an explicit yes.
 */
export async function postRun(runRoot: string, options: { color: boolean }): Promise<void> {
  const paint: Paint = (style, text) =>
    options.color ? styleText(style, text, { validateStream: false }) : text;
  const paths = runDirPaths(runRoot);
  const run = await readJsonOrNull<RunRecord>(paths.runJsonPath);
  if (run === null) throw new Error(`No run.json in ${runRoot}`);
  const { pr } = run;
  if (pr === undefined)
    throw new Error("Only PR reviews can be posted; this run reviewed a branch.");
  if (run.status !== "ok") throw new Error("This run failed, so it has nothing to post.");
  if (!interactive()) throw new Error("Posting asks for confirmation, so it needs a terminal.");

  const findings = (await readJsonOrNull<NormalizedFinding[]>(paths.findingsPath)) ?? [];
  const verdicts = (await readJsonOrNull<Record<string, Verdict>>(paths.verdictsPath)) ?? {};
  const items = postableItems(findings, verdicts);
  if (items.length === 0) {
    console.error("Nothing to post: no findings, or all were refuted.");
    return;
  }

  const posted = await readJsonOrNull<PostedRecord>(paths.postedPath);
  if (posted !== null) {
    console.error(`This run was already posted: ${posted.url}`);
    if (!(await confirm("Post again?"))) return;
  }

  console.error(`\nFindings for PR #${pr.number}: ${pr.title}`);
  items.forEach(({ finding, verdict, preselected }, index) => {
    console.error(
      `  ${preselected ? "[x]" : "[ ]"} ${String(index + 1).padStart(2)}. ` +
        `${paint("bold", finding.id)} ${verdict.severity} ${verdict.verdict}  ` +
        `${paint("cyan", formatLocation(finding))}  ${finding.title}`,
    );
  });
  const defaults = items.flatMap((item, index) => (item.preselected ? [index] : []));
  let selected: number[];
  for (;;) {
    const answer = await ask(
      `Post which? Numbers like 1,3-4; Enter for the [x] ones${defaults.length === 0 ? " (none)" : ""}; 0 to cancel: `,
    );
    if (answer === "0") return;
    const parsed = answer === "" ? defaults : parseSelection(answer, items.length);
    if (parsed !== null && parsed.length > 0) {
      selected = parsed;
      break;
    }
    console.error(
      parsed === null ? `Pick numbers from 1 to ${items.length}.` : "Nothing selected.",
    );
  }

  const reviewed = run.head.sha;
  const current = await currentPrHead(runRoot, pr);
  if (current !== reviewed) {
    console.error(
      paint(
        "yellow",
        `PR #${pr.number} has moved since this review (reviewed ${reviewed.slice(0, 7)}, now ` +
          `${current.slice(0, 7)}). Comments are anchored to the reviewed commit, so GitHub ` +
          "shows them as outdated. To review the new commits, run the review again.",
      ),
    );
    if (!(await confirm("Post on the reviewed commit anyway?"))) return;
  }

  const diff = await readFile(paths.diffPath, "utf8");
  const plan = buildReview(
    selected.map((index) => items[index]!),
    diff,
    reviewed,
  );
  console.error(`\n${paint("bold", "Review body")}\n${plan.payload.body}`);
  for (const comment of plan.payload.comments) {
    const lines =
      comment.start_line === undefined
        ? `${comment.line}`
        : `${comment.start_line}-${comment.line}`;
    console.error(`\n${paint(["bold", "cyan"], `${comment.path}:${lines}`)}\n${comment.body}`);
  }
  console.error("");
  if (!(await confirm(`Post this review to ${pr.url} as a comment review?`))) return;

  const review = await postReview(runRoot, pr, plan.payload);
  // Comments come back in an unspecified order; match each to its finding by path and body.
  const unclaimed = [...(review.comments ?? [])];
  const record: PostedRecord = {
    postedAt: new Date().toISOString(),
    reviewId: review.id,
    url: review.url,
    commitId: reviewed,
    findings: [
      ...plan.inline.map((id, index) => {
        const sent = plan.payload.comments[index]!;
        const at = unclaimed.findIndex((c) => c.path === sent.path && c.body === sent.body);
        const commentId = at === -1 ? null : unclaimed.splice(at, 1)[0]!.id;
        return { id, commentId };
      }),
      ...plan.inBody.map((id) => ({ id, commentId: null })),
    ],
  };
  await writeJson(paths.postedPath, record);
  console.log(`Posted: ${review.url}`);
  if (review.comments === null && plan.inline.length > 0) {
    console.error(
      paint("yellow", "Couldn't read back the inline comments; their ids aren't in posted.json."),
    );
  }
}
