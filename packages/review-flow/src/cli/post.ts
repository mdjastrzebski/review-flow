import { readFile } from "node:fs/promises";
import { styleText } from "node:util";
import {
  buildReview,
  currentPrHead,
  formatLocation,
  postableItems,
  postableRoughEdges,
  postReview,
  prTrust,
  readJsonOrNull,
  runDirPaths,
  writeJson,
  type CheckedRoughEdge,
  type NormalizedFinding,
  type PostedRecord,
  type RunRecord,
  type Summary,
  type Verdict,
} from "../core/index.ts";
import { confirm, interactive, note, pick, type Choice } from "./prompt.ts";

type Paint = (style: Parameters<typeof styleText>[0], text: string) => string;

/** The picker entry for the run's summary; finding ids look like `F-001`. */
const SUMMARY = "summary";

/**
 * Posts the summary and selected findings of a PR run as one COMMENT review: select, check the
 * PR head, preview, confirm, send. Needs a TTY; nothing is posted without an explicit yes.
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
  const items = [
    ...postableItems(findings, verdicts),
    ...postableRoughEdges((await readJsonOrNull<CheckedRoughEdge[]>(paths.roughEdgesPath)) ?? []),
  ];
  const summary = await readJsonOrNull<Summary>(paths.summaryPath);
  if (items.length === 0 && summary === null) {
    note.info("Nothing to post: no summary, and no findings or rough edges, or all were refuted.");
    return;
  }

  const posted = await readJsonOrNull<PostedRecord>(paths.postedPath);
  if (posted !== null) {
    note.warn(`This run was already posted: ${posted.url}`);
    if (!(await confirm("Post again?"))) return;
  }

  const choices: Choice<string>[] = items.map((item) => ({
    value: item.id,
    label:
      `${paint("bold", item.id)} ${item.tag}  ` +
      `${paint("cyan", formatLocation(item.location))}  ${item.title}`,
    ...(item.hint === null ? {} : { hint: item.hint }),
  }));
  if (summary !== null) {
    choices.unshift({
      value: SUMMARY,
      label: paint("bold", "Summary"),
      hint: "goal, changes, and where to look, in the review body",
    });
  }
  const initial = [
    ...(summary === null ? [] : [SUMMARY]),
    ...items.flatMap((item) => (item.preselected ? [item.id] : [])),
  ];
  const picked = await pick(`Post to PR #${pr.number}: ${pr.title}`, choices, initial);
  if (picked === null) return;
  const selected = items.filter((item) => picked.includes(item.id));
  if (selected.length === 0 && !picked.includes(SUMMARY)) {
    note.info("Nothing selected.");
    return;
  }

  const reviewed = run.head.sha;
  const current = await currentPrHead(runRoot, pr);
  if (current !== reviewed) {
    note.warn(
      `PR #${pr.number} has moved since this review (reviewed ${reviewed.slice(0, 7)}, now ` +
        `${current.slice(0, 7)}). Comments are anchored to the reviewed commit, so GitHub ` +
        "shows them as outdated. To review the new commits, run the review again.",
    );
    if (!(await confirm("Post on the reviewed commit anyway?"))) return;
  }

  const diff = await readFile(paths.diffPath, "utf8");
  const plan = buildReview(selected, diff, reviewed, {
    summary: picked.includes(SUMMARY) ? summary : null,
    trust: (run.trust ?? prTrust(pr)).level,
  });
  note.box(plan.payload.body, "Review body");
  for (const comment of plan.payload.comments) {
    const lines =
      comment.start_line === undefined
        ? `${comment.line}`
        : `${comment.start_line}-${comment.line}`;
    note.box(comment.body, `${comment.path}:${lines}`);
  }
  if (!(await confirm(`Post this review to ${pr.url} as a comment review?`))) return;

  const review = await postReview(runRoot, pr, plan.payload);
  // Comments come back in an unspecified order; match each to its item by path and body.
  const unclaimed = [...(review.comments ?? [])];
  const record: PostedRecord = {
    postedAt: new Date().toISOString(),
    reviewId: review.id,
    url: review.url,
    commitId: reviewed,
    items: [
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
    note.warn("Couldn't read back the inline comments; their ids aren't in posted.json.");
  }
}
