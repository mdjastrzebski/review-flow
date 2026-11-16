import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunAgent } from "../../runtime/agent.ts";
import type { TaskActivity } from "../../runtime/call.ts";
import { startRun, type FlowContext, type TimedStep } from "../../runtime/flow.ts";
import { formatDuration } from "../../runtime/format.ts";
import { writeJson } from "../../runtime/json.ts";
import { findNode, type FlowNode, type RunRecordBase } from "../../runtime/records.ts";
import { describeModel } from "../format.ts";
import {
  assertStatusUnchanged,
  commitMessages,
  diffAgainstBase,
  resolveCommit,
  resolveRepoRoot,
  shortSha,
  snapshotStatus,
  snapshotWorkingTree,
} from "../git.ts";
import type { PullRequest } from "../github.ts";
import type { Harness, RoleModels } from "../models.ts";
import { renderReport, type ReportMeta } from "../report.ts";
import { createRunDir, ensureStateDir, RUN_FILES, runDirPaths, type RunDir } from "../run-dir.ts";
import { createRunDirAt } from "../../runtime/run-dir.ts";
import {
  appendIndexEntry,
  diffStats,
  readIndex,
  type DiffStats,
  type VerdictCounts,
} from "../run-index.ts";
import type { CheckedRoughEdge, NormalizedFinding, Summary, Verdict } from "../schemas.ts";
import type { Intent, SummaryOutcome } from "../summary.ts";
import { estimateCost, type CostEstimate, type Trust, type TrustLevel } from "../trust.ts";
import { buildChangeContext, changeRangeOf, type ChangeRange } from "../verify.ts";
import { find, type FindResult } from "./find.ts";
import { REVIEW_PATH } from "./paths.ts";
import { type ReviewScope } from "./scope.ts";
import { summarize } from "./summarize.ts";

export { failedVerdict, VERIFIER_CONCURRENCY } from "./verify.ts";
export { REVIEW_PATH } from "./paths.ts";

/**
 * run.json of a review, written as `running` when the run dir is made and again when the run
 * ends. Per-call detail is in calls.jsonl.
 */
export type RunRecord = RunRecordBase & ReviewMeta;

/** The review's inputs, at the top level of run.json. */
export interface ReviewMeta {
  harness: Harness;
  models: RoleModels;
  base: { ref: string; sha: string };
  /** snapshotSha: the commit holding uncommitted changes that was reviewed instead of HEAD. */
  head: { sha: string; snapshotSha?: string };
  pr?: PullRequest;
  /** Missing in runs from before trust levels. */
  trust?: Trust;
  /** The checkout agents read. Missing in runs from before `ask`. */
  checkout?: string;
  /** Steps the run was started with. Missing in runs from before `ask`. */
  summarize?: boolean;
  find?: boolean;
  roughEdges?: boolean;
}

export interface ReviewRunOptions {
  /** Any directory inside the repository to review. */
  cwd: string;
  base: string;
  /** The target's trust level; recorded, and sets the policies of section 3 of the spec. */
  trust: Trust;
  harness: Harness;
  models: RoleModels;
  runAgent: RunAgent;
  log: (message: string) => void;
  /**
   * Asked before any agent runs on an `external` target, with the diff size and a cost estimate
   * from past runs; false stops the run with a DeclinedError. Without it, external targets run.
   */
  confirmSpend?: (preflight: Preflight) => Promise<boolean>;
  /** A problem that doesn't stop the run, such as a failed verifier. Default: `log`. */
  warn?: (message: string) => void;
  /** The summary, as soon as it is written. Default: a `Summary written` line. */
  onSummary?: (summary: Summary, trust: TrustLevel) => void;
  /**
   * The command that asks about this run from another terminal, shown in the review box.
   * Without it, no such row.
   */
  askCommand?: (runId: string, answerer: { harness: Harness; model: string | null }) => string;
  /** Labelled facts about the run (models, run dir), shown together. Default: one `log` each. */
  logTable?: LogTable;
  /**
   * Live agent activity, for a status line: each tool call or heartbeat, then the end of the task.
   * Without it, each is logged as `  [taskId 0:12] text`.
   */
  onActivity?: (activity: TaskActivity) => void;
  /** Also log run setup, each agent's command and text, tokens per call, and step times. */
  verbose?: boolean;
  /** Review HEAD only; by default uncommitted changes are reviewed too, through a snapshot. */
  committedOnly?: boolean;
  /**
   * Where to create the run dir. By default it goes in the repo's `.review-flow/runs/` and is
   * indexed; with a path, the repo's .gitignore and index are left alone.
   */
  runRoot?: string;
  /**
   * The repo whose `.review-flow/` holds the run dir and index, when `cwd` is a review worktree.
   * Default: the reviewed repo.
   */
  stateRepo?: string;
  /** The PR whose head `cwd` is checked out at; recorded so the run can be posted. */
  pr?: PullRequest;
  /** The PR's description, the summary's source for the stated goal. */
  prBody?: string;
  /** Run Summarize, in parallel with Find (default: true). */
  summarize?: boolean;
  /** Run Find and Verify (default: true); `review-flow summary` turns it off. */
  find?: boolean;
  /**
   * Ask the reviewer for rough edges and check them (default: true). Off for evals, which score
   * findings only.
   */
  roughEdges?: boolean;
}

/** What `confirmSpend` is shown. */
export interface Preflight {
  trust: Trust;
  diff: DiffStats;
  /** null without past runs to base it on. */
  estimate: CostEstimate | null;
}

type LogTable = (title: string, rows: readonly (readonly [string, string])[]) => void;

export interface ReviewRunResult {
  runDir: RunDir;
  /** The checkout agents read: the repo root, or the review worktree. */
  checkout: string;
  /** null when Summarize was skipped. */
  summary: SummaryOutcome | null;
  /** Empty when Find was skipped. */
  findings: NormalizedFinding[];
  /** findingId → verdict, with the code-enforced rules applied. */
  verdicts: Record<string, Verdict>;
  /** Checked rough edges, `inaccurate` ones included; empty when not asked for. */
  roughEdges: CheckedRoughEdge[];
  /** null when no call has a reported or computed cost. */
  costUsd: number | null;
  durationMs: number;
}

/** collect → (summarize ‖ review → normalize → verify → rank) → report. */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const prepared = await prepareReview(options);
  const { input } = prepared;
  const { meta } = input;
  const { runRoot } = options;
  const stateRepo = options.stateRepo ?? input.repo;
  const runDir =
    runRoot === undefined
      ? await createRunDir(stateRepo, await shortSha(input.repo, "HEAD"), prepared.startedAt)
      : runDirPaths((await createRunDirAt(runRoot)).root);
  // Before the Ask hint and the `running` run.json, so an `ask` that finds the run can read them.
  await writeFile(runDir.diffPath, input.diff);
  await writeJson(runDir.intentPath, input.intent);
  return runPreparedReview(prepared, {
    runDir,
    logTable:
      options.logTable ??
      ((_, rows) => {
        for (const [label, value] of rows) options.log(`${label}: ${value}`);
      }),
    ...(options.askCommand === undefined ? {} : { askCommand: options.askCommand }),
    verbose: options.verbose ?? false,
    launch: async (flow, flowInput, run) => {
      // Outside the flow, so a failed run still indexes what it got to.
      let findings: number | null = null;
      let verdicts: VerdictCounts | null = null;
      let node: FlowNode | null = null;
      const hooks = flowInput.hooks;
      const result = await startRun(
        flow,
        {
          ...flowInput,
          hooks: { ...hooks, onFindings: (n) => (findings = n), onVerdicts: (v) => (verdicts = v) },
        },
        {
          dir: runDir,
          runAgent: options.runAgent,
          harness: meta.harness,
          log: options.log,
          ...(options.warn === undefined ? {} : { warn: options.warn }),
          ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
          verbose: options.verbose ?? false,
          ...run,
          onFinish: async (record) => {
            node = record.flow;
            if (runRoot !== undefined) return;
            await appendIndexEntry(stateRepo, {
              id: path.basename(runDir.root),
              kind: "review",
              startedAt: record.startedAt,
              durationMs: record.totals.durationMs,
              status: record.status === "ok" ? "ok" : "failed",
              harness: meta.harness,
              models: meta.models,
              base: meta.base,
              head: meta.head,
              ...(meta.pr === undefined ? {} : { pr: meta.pr.number }),
              diff: prepared.stats,
              findings,
              verdicts,
              costUsd: record.totals.costUsd,
              unknownCostCalls: record.totals.unknownCostCalls,
            });
          },
        },
      );
      return { result, node };
    },
  });
}

/** Where and how `runPreparedReview` runs a prepared review. */
export interface PreparedReviewRun {
  /** The run dir the review writes to; `launch` creates it if it doesn't exist yet. */
  runDir: RunDir;
  /** Shows the review box before the run and the saved files after it. */
  logTable: LogTable;
  askCommand?: ReviewRunOptions["askCommand"];
  /** Adds step times to the saved files. */
  verbose: boolean;
  /**
   * Runs `flow` on `input` with `run`'s options, as a top-level run (`startRun`) or nested in
   * another flow (`ctx.run`); returns the result and the review's flow node.
   */
  launch: (
    flow: typeof review,
    input: ReviewInput,
    run: ReviewLaunch,
  ) => Promise<{ result: ReviewRunResult; node: FlowNode | null }>;
}

/** The run options every review is started with, for `startRun` or `ctx.run`. */
export interface ReviewLaunch {
  /** run.json's review fields. */
  meta: Record<string, unknown>;
  /** Collect, timed up to the run's start. */
  before: TimedStep[];
  /** Fails the call when an agent changed the checkout. */
  afterCall: () => Promise<void>;
}

/**
 * Runs a prepared review into `runDir`: shows the review box, runs the review flow through
 * `launch` with collect as its first step and the checkout guard after each call, then lists the
 * saved files.
 */
export async function runPreparedReview(
  prepared: PreparedReview,
  { runDir, logTable, askCommand, verbose, launch }: PreparedReviewRun,
): Promise<ReviewRunResult> {
  logTable("Review", reviewRows(prepared, runDir, askCommand));
  const { result, node } = await launch(review, prepared.input, {
    meta: { ...prepared.input.meta },
    before: [collectStep(prepared)],
    afterCall: prepared.afterCall,
  });
  logTable("Saved", savedRows(result, prepared.input.steps, verbose ? node : null));
  return result;
}

/** A collected review: the flow's input and the checkout guard; run with `runPreparedReview`. */
export interface PreparedReview {
  input: ReviewInput;
  /** The review box's rows up to the checkout. */
  setup: [string, string][];
  /** When collect started: the run's start. */
  startedAt: Date;
  stats: DiffStats;
  /** Fails the call when an agent changed the checkout; agents are read-only by configuration. */
  afterCall: () => Promise<void>;
}

/** What the review flow works from, gathered before its run dir exists. */
export interface ReviewInput {
  /** The checkout agents read. */
  repo: string;
  diff: string;
  change: ChangeRange;
  intent: Intent;
  models: RoleModels;
  /** run.json's review fields; the report's header shows some of them. */
  meta: ReviewMeta & { trust: Trust };
  steps: { summarize: boolean; find: boolean; roughEdges: boolean };
  hooks?: ReviewHooks;
}

/** Progress as the review goes on. */
export interface ReviewHooks {
  /** The summary, as soon as it is written. Default: a `Summary written` line. */
  onSummary?: ((summary: Summary) => void) | undefined;
  /** The reviewer's finding count; for the run index. */
  onFindings?: ((count: number) => void) | undefined;
  /** The verdict counts once verification is done; for the run index. */
  onVerdicts?: ((counts: VerdictCounts) => void) | undefined;
}

/**
 * Collect: resolves the commits, takes the diff (NoChangesError when empty), asks before spending
 * on an external target (DeclinedError), and snapshots the checkout's status. No run dir yet, so a
 * run with nothing to review leaves nothing behind.
 */
export async function prepareReview(options: ReviewRunOptions): Promise<PreparedReview> {
  const { base, trust, harness, models, pr } = options;
  const verbose = options.verbose ?? false;
  const runSummarize = options.summarize ?? true;
  const runFind = options.find ?? true;
  const roughEdges = (options.roughEdges ?? true) && runFind;
  const startedAt = new Date();
  const repo = await resolveRepoRoot(options.cwd);
  const baseSha = await resolveCommit(repo, base);
  const headSha = await resolveCommit(repo, "HEAD");
  const snapshot = options.committedOnly ? null : await snapshotWorkingTree(repo);
  const head = snapshot === null ? { sha: headSha } : { sha: headSha, snapshotSha: snapshot.sha };
  const change = changeRangeOf(base, { pr, uncommitted: snapshot !== null });

  const diff = await diffAgainstBase(repo, base, snapshot?.sha);
  if (diff.trim() === "") {
    throw new NoChangesError(base, snapshot !== null);
  }
  const stats = diffStats(diff);
  const stateRepo = options.stateRepo ?? repo;
  if (trust.level === "external" && options.confirmSpend !== undefined) {
    const estimate = estimateCost(await readIndex(stateRepo), harness, stats, runFind);
    if (!(await options.confirmSpend({ trust, diff: stats, estimate }))) throw new DeclinedError();
  }
  const setup: [string, string][] = [
    ["Trust", `${trust.level} (${trust.reason})`],
    ["Harness", harness],
  ];
  if (verbose) {
    setup.push(
      ["Repo", repo],
      ["Base", `${base} (${baseSha.slice(0, 7)})`],
      [
        "Head",
        headSha.slice(0, 7) +
          (snapshot === null ? "" : ` + uncommitted (snapshot ${snapshot.sha.slice(0, 7)})`),
      ],
      [
        "Diff",
        `${stats.files} file(s), +${stats.additions} −${stats.deletions}, ${diff.length} chars`,
      ],
    );
  }
  if (snapshot !== null) setup.push(["Uncommitted", `${snapshot.files} file(s) included`]);
  if (runSummarize) setup.push(["Summarizer", describeModel(models.summarizer)]);
  if (runFind) {
    setup.push(["Reviewer", describeModel(models.reviewer)]);
    setup.push(["Verifier", describeModel(models.verifier)]);
  }
  const intent: Intent =
    pr !== undefined
      ? {
          kind: "pr",
          number: pr.number,
          title: pr.title,
          body: options.prBody ?? "",
        }
      : {
          kind: "commits",
          messages: await commitMessages(repo, base),
          uncommitted: snapshot !== null,
        };

  if (options.runRoot === undefined) await ensureStateDir(stateRepo);
  // Taken after .review-flow/ exists; agents must leave the tree exactly like this.
  const status = await snapshotStatus(repo);

  const { onSummary } = options;
  return {
    input: {
      repo,
      diff,
      change,
      intent,
      models,
      meta: {
        harness,
        models,
        base: { ref: base, sha: baseSha },
        head,
        ...(pr === undefined ? {} : { pr }),
        trust,
        checkout: repo,
        summarize: runSummarize,
        find: runFind,
        roughEdges,
      },
      steps: { summarize: runSummarize, find: runFind, roughEdges },
      hooks: { onSummary: onSummary && ((summary) => onSummary(summary, trust.level)) },
    },
    setup,
    startedAt,
    stats,
    afterCall: () => assertStatusUnchanged(repo, status),
  };
}

/** The branch has no changes against the base; not a failure, just nothing to review. */
export class NoChangesError extends Error {
  constructor(
    readonly base: string,
    readonly withUncommitted = false,
  ) {
    super(
      `No changes between ${base} and HEAD${withUncommitted ? " plus uncommitted changes" : ""}.`,
    );
    this.name = "NoChangesError";
  }
}

/** The user declined to spend on the review; nothing ran. */
export class DeclinedError extends Error {
  constructor() {
    super("Review declined; no agents ran.");
    this.name = "DeclinedError";
  }
}

/** The review box: collect's rows, then the checkout, the run dir, and how to ask about the run. */
function reviewRows(
  prepared: PreparedReview,
  runDir: RunDir,
  askCommand?: ReviewRunOptions["askCommand"],
): [string, string][] {
  const { input } = prepared;
  const rows: [string, string][] = [
    ...prepared.setup,
    ["Checkout", input.repo],
    ["Run dir", runDir.root],
  ];
  if (askCommand !== undefined) {
    const answerer = { harness: input.meta.harness, model: input.models.verifier.model };
    rows.push(["Ask", askCommand(path.basename(runDir.root), answerer)]);
  }
  return rows;
}

/**
 * (summarize ‖ find) → report. Summarize and Find run in parallel; the first to throw stops the
 * other, and both settle before the run ends, so run.json records every call.
 */
export async function review(input: ReviewInput, ctx: FlowContext): Promise<ReviewRunResult> {
  const { repo, change, diff, models, steps, hooks = {} } = input;
  // Read by `ask` while the review goes on. `runReview` writes them before the run starts too.
  await ctx.writeFile(RUN_FILES.diff, diff);
  await ctx.writeFile(RUN_FILES.intent, input.intent);

  const sharedContext = buildChangeContext(change, diff);
  const scope: ReviewScope = { repo, change, sharedContext, models };
  const { summary, found } = await ctx.parallel({
    summary: steps.summarize
      ? (c: FlowContext) =>
          c.run(summarize, { scope, intent: input.intent, onSummary: hooks.onSummary })
      : skipped,
    found: steps.find
      ? (c: FlowContext) =>
          c.run(find, {
            scope,
            diff,
            roughEdges: steps.roughEdges,
            onFindings: hooks.onFindings,
            onVerdicts: hooks.onVerdicts,
          })
      : skipped,
  });
  // A summary-only run with no summary has nothing to show.
  if (found === null && summary?.status === "failed") {
    throw new Error(`Summarizer failed (${summary.error})`);
  }

  const { durationMs, totals } = ctx.snapshot();
  const { costUsd } = totals;
  await ctx.step("report", (c) =>
    c.writeFile(
      RUN_FILES.report,
      renderReport({
        ...reportMeta(input.meta),
        models,
        durationMs,
        costUsd,
        summary,
        ...(found ?? { ...NOTHING_FOUND, findings: null }),
      }),
    ),
  );
  return {
    runDir: runDirPaths(ctx.runDir.root),
    checkout: repo,
    summary,
    ...(found ?? NOTHING_FOUND),
    costUsd,
    durationMs,
  };
}

const skipped = async () => null;

/** The review's facts the report's header shows. */
function reportMeta({ harness, base, head, pr, trust }: ReviewInput["meta"]): ReportMeta {
  return { harness, base, head, ...(pr === undefined ? {} : { pr }), trust: trust.level };
}

const NOTHING_FOUND: FindResult = { findings: [], verdicts: {}, roughEdges: [] };

/** Collect's step, timed up to now; recorded as the run's first step. */
function collectStep({ startedAt }: PreparedReview): TimedStep {
  return { name: "collect", startedAt, durationMs: Date.now() - startedAt.getTime() };
}

/** The files a finished review wrote; with its flow node, also the step times. */
function savedRows(
  { runDir, summary }: ReviewRunResult,
  steps: ReviewInput["steps"],
  node: FlowNode | null,
): [string, string][] {
  const rows: [string, string][] = [];
  if (summary?.status === "ok") rows.push(["Summary", runDir.summaryPath]);
  if (steps.find) rows.push(["Findings", runDir.findingsPath], ["Verdicts", runDir.verdictsPath]);
  if (steps.roughEdges) rows.push(["Rough edges", runDir.roughEdgesPath]);
  rows.push(["Report", runDir.reportPath]);
  if (node !== null) {
    const times = STEP_ROW.flatMap((step) => {
      const ran = findNode(node, step);
      return ran === undefined ? [] : [`${ran.name} ${formatDuration(ran.durationMs)}`];
    });
    rows.push(["Steps", times.join(" · ")]);
  }
  return rows;
}

/** Nodes listed in the verbose `Steps` row, by path below the review node. */
const STEP_ROW = [
  REVIEW_PATH.collect,
  REVIEW_PATH.summarize,
  REVIEW_PATH.review,
  REVIEW_PATH.verify,
  REVIEW_PATH.check,
  REVIEW_PATH.report,
];
