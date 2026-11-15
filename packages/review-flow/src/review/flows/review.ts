import path from "node:path";
import type { RunAgent } from "../../runtime/agent.ts";
import type { TaskActivity } from "../../runtime/call.ts";
import { startRun, type FlowContext, type TimedStep } from "../../runtime/flow.ts";
import { formatDuration } from "../../runtime/format.ts";
import { findNode, type RunRecordBase } from "../../runtime/records.ts";
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
import { loadPrompt } from "../prompts.ts";
import { renderReport } from "../report.ts";
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
import { find } from "./find.ts";
import { type ReviewScope } from "./scope.ts";
import { summarize } from "./summarize.ts";

export { failedVerdict, VERIFIER_CONCURRENCY } from "./verify.ts";

type LogTable = (title: string, rows: readonly (readonly [string, string])[]) => void;

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

/**
 * run.json of a review, written as `running` when the run dir is made and again when the run
 * ends. Per-call detail is in calls.jsonl.
 */
export type RunRecord = RunRecordBase & ReviewMeta;

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

/** What `confirmSpend` is shown. */
export interface Preflight {
  trust: Trust;
  diff: DiffStats;
  /** null without past runs to base it on. */
  estimate: CostEstimate | null;
}

/** The user declined to spend on the review; nothing ran. */
export class DeclinedError extends Error {
  constructor() {
    super("Review declined; no agents ran.");
    this.name = "DeclinedError";
  }
}

/** What the review flow works from, gathered before its run dir exists. */
export interface ReviewInput {
  /** The checkout agents read. */
  repo: string;
  diff: string;
  change: ChangeRange;
  intent: Intent;
  harness: Harness;
  models: RoleModels;
  trust: TrustLevel;
  base: { ref: string; sha: string };
  head: ReviewMeta["head"];
  pr?: PullRequest;
  summarize: boolean;
  find: boolean;
  roughEdges: boolean;
  /** The review box's rows up to the checkout; the flow adds the checkout and run dir. */
  setup: [string, string][];
  logTable?: LogTable;
  onSummary?: ReviewRunOptions["onSummary"];
  askCommand?: ReviewRunOptions["askCommand"];
  onFindings?: (count: number) => void;
  onVerdicts?: (counts: VerdictCounts) => void;
}

/** A collected review: the flow's input, run.json's fields, and the checkout guard. */
export interface PreparedReview {
  input: ReviewInput;
  meta: ReviewMeta;
  /** When collect started: the run's start. */
  startedAt: Date;
  stats: DiffStats;
  /** Fails the call when an agent changed the checkout; agents are read-only by configuration. */
  afterCall: () => Promise<void>;
}

/**
 * Collect: resolves the commits, takes the diff (NoChangesError when empty), asks before spending
 * on an external target (DeclinedError), and snapshots the checkout's status. No run dir yet, so a
 * run with nothing to review leaves nothing behind.
 */
export async function prepareReview(options: ReviewRunOptions): Promise<PreparedReview> {
  const { base, trust, harness, models, pr } = options;
  const verbose = options.verbose ?? false;
  const summarize = options.summarize ?? true;
  const find = options.find ?? true;
  const roughEdges = (options.roughEdges ?? true) && find;
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
    const estimate = estimateCost(await readIndex(stateRepo), harness, stats, find);
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
  if (summarize) setup.push(["Summarizer", describeModel(models.summarizer)]);
  if (find) {
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

  const baseRef = { ref: base, sha: baseSha };
  const optional = {
    ...(pr === undefined ? {} : { pr }),
    ...(options.logTable === undefined ? {} : { logTable: options.logTable }),
    ...(options.onSummary === undefined ? {} : { onSummary: options.onSummary }),
    ...(options.askCommand === undefined ? {} : { askCommand: options.askCommand }),
  };
  return {
    input: {
      repo,
      diff,
      change,
      intent,
      harness,
      models,
      trust: trust.level,
      base: baseRef,
      head,
      summarize,
      find,
      roughEdges,
      setup,
      ...optional,
    },
    meta: {
      harness,
      models,
      base: baseRef,
      head,
      ...(pr === undefined ? {} : { pr }),
      trust,
      checkout: repo,
      summarize,
      find,
      roughEdges,
    },
    startedAt,
    stats,
    afterCall: () => assertStatusUnchanged(repo, status),
  };
}

/** Collect's step, timed up to now; recorded as the run's first step. */
export function collectStep({ startedAt }: PreparedReview): TimedStep {
  return { name: "collect", startedAt, durationMs: Date.now() - startedAt.getTime() };
}

/** Nodes listed in the verbose `Steps` row, by path below the review node. */
const STEP_ROW = ["collect", "summarize", "find/review", "find/verify", "find/check", "report"];

/**
 * (summarize ‖ find) → report. Summarize and Find run in parallel; the first to throw stops the
 * other, and both settle before the run ends, so run.json records every call.
 */
export async function review(input: ReviewInput, ctx: FlowContext): Promise<ReviewRunResult> {
  const { repo, change, models } = input;
  const runDir = runDirPaths(ctx.runDir.root);
  // Read by `ask` while the review goes on.
  await ctx.writeFile(RUN_FILES.diff, input.diff);
  await ctx.writeFile(RUN_FILES.intent, input.intent);
  const logTable: LogTable =
    input.logTable ??
    ((_, rows) => {
      for (const [label, value] of rows) ctx.log(`${label}: ${value}`);
    });
  const setup = [...input.setup, ["Checkout", repo] as const, ["Run dir", runDir.root] as const];
  if (input.askCommand !== undefined) {
    setup.push([
      "Ask",
      input.askCommand(path.basename(runDir.root), {
        harness: input.harness,
        model: models.verifier.model,
      }),
    ]);
  }
  logTable("Review", setup);

  const sharedContext = buildChangeContext(await loadPrompt("change"), change, input.diff);
  const scope: ReviewScope = { repo, change, sharedContext, models };
  const { summary, found } = await ctx.parallel({
    summary: (c) =>
      input.summarize
        ? c.run(summarize, {
            scope,
            intent: input.intent,
            onSummary: (summary) =>
              input.onSummary === undefined
                ? c.log("Summary written")
                : input.onSummary(summary, input.trust),
          })
        : Promise.resolve(null),
    found: (c) =>
      input.find
        ? c.run(find, {
            scope,
            diff: input.diff,
            roughEdges: input.roughEdges,
            ...(input.onFindings === undefined ? {} : { onFindings: input.onFindings }),
            ...(input.onVerdicts === undefined ? {} : { onVerdicts: input.onVerdicts }),
          })
        : Promise.resolve(null),
  });
  if (!input.find && summary?.status === "failed") {
    throw new Error(`Summarizer failed (${summary.error})`);
  }
  const findings = found?.findings ?? [];
  const verdicts = found?.verdicts ?? {};
  const edges = found?.roughEdges ?? [];

  const { durationMs, totals } = ctx.snapshot();
  const { costUsd } = totals;
  await ctx.step("report", async (c) => {
    const report = renderReport({
      harness: input.harness,
      models,
      base: input.base,
      head: input.head,
      ...(input.pr === undefined ? {} : { pr: input.pr }),
      trust: input.trust,
      durationMs,
      costUsd,
      summary,
      findings: found === null ? null : findings,
      verdicts,
      roughEdges: edges,
    });
    await c.writeFile(RUN_FILES.report, report);
  });
  const saved: [string, string][] = [];
  if (summary?.status === "ok") saved.push(["Summary", runDir.summaryPath]);
  if (found !== null) {
    saved.push(["Findings", runDir.findingsPath], ["Verdicts", runDir.verdictsPath]);
    if (input.roughEdges) saved.push(["Rough edges", runDir.roughEdgesPath]);
  }
  saved.push(["Report", runDir.reportPath]);
  if (ctx.verbose) {
    const node = ctx.snapshot();
    const steps = STEP_ROW.flatMap((step) => {
      const ran = findNode(node, step);
      return ran === undefined ? [] : [`${ran.name} ${formatDuration(ran.durationMs)}`];
    });
    saved.push(["Steps", steps.join(" · ")]);
  }
  logTable("Saved", saved);

  return {
    runDir,
    checkout: repo,
    summary,
    findings,
    verdicts,
    roughEdges: edges,
    costUsd,
    durationMs,
  };
}

/** collect → (summarize ‖ review → normalize → verify → rank) → report. */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const prepared = await prepareReview(options);
  const { input, meta } = prepared;
  const { runRoot } = options;
  const stateRepo = options.stateRepo ?? input.repo;
  const runDir =
    runRoot === undefined
      ? await createRunDir(stateRepo, await shortSha(input.repo, "HEAD"), prepared.startedAt)
      : runDirPaths((await createRunDirAt(runRoot)).root);
  // Outside the flow, so a failed run still indexes what it got to.
  let findings: number | null = null;
  let verdicts: VerdictCounts | null = null;
  return startRun(
    review,
    { ...input, onFindings: (n) => (findings = n), onVerdicts: (v) => (verdicts = v) },
    {
      dir: runDir,
      runAgent: options.runAgent,
      harness: input.harness,
      log: options.log,
      ...(options.warn === undefined ? {} : { warn: options.warn }),
      ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
      verbose: options.verbose ?? false,
      meta: { ...meta },
      before: [collectStep(prepared)],
      afterCall: prepared.afterCall,
      ...(runRoot === undefined
        ? {
            onFinish: async (run) => {
              await appendIndexEntry(stateRepo, {
                id: path.basename(runDir.root),
                kind: "review",
                startedAt: run.startedAt,
                durationMs: run.totals.durationMs,
                status: run.status === "ok" ? "ok" : "failed",
                harness: meta.harness,
                models: meta.models,
                base: meta.base,
                head: meta.head,
                ...(meta.pr === undefined ? {} : { pr: meta.pr.number }),
                diff: prepared.stats,
                findings,
                verdicts,
                costUsd: run.totals.costUsd,
                unknownCostCalls: run.totals.unknownCostCalls,
              });
            },
          }
        : {}),
    },
  );
}
