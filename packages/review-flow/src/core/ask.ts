import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentStatus, RunAgent } from "./agent.ts";
import type { CallRecord, CostSource } from "./calls.ts";
import { formatLocation } from "./format.ts";
import { hasCommit, resolveCommit, snapshotStatus, snapshotWorkingTree, treeOf } from "./git.ts";
import { readJsonOrNull } from "./json.ts";
import type { Harness, ModelChoice } from "./models.ts";
import type { RunRecord } from "./pipeline.ts";
import { codeFence, loadPrompt, renderPrompt } from "./prompts.ts";
import { rankFindings } from "./rank.ts";
import { renderSummary } from "./report.ts";
import { ensureStateDir, runDirPaths, type RunDir } from "./run-dir.ts";
import { countVerdicts, runsPath, type VerdictCounts } from "./run-index.ts";
import { Answer, type NormalizedFinding, type Summary, type Verdict } from "./schemas.ts";
import { describeIntent, type Intent, type SummaryOutcome } from "./summary.ts";
import { runTask, type TaskActivity, type TaskContext } from "./task.ts";
import { prTrust, type TrustLevel } from "./trust.ts";
import { buildChangeContext, changeRangeOf, type ChangeRange } from "./verify.ts";
import {
  createReviewWorktree,
  isAlive,
  reviewWorktree,
  takeLease,
  worktreesDir,
} from "./worktree.ts";

const ANSWERER_TIMEOUT_MS = 10 * 60 * 1000;
/** Earlier questions and answers kept in the prompt, newest first, so a long session stays cheap. */
export const MAX_HISTORY_CHARS = 20_000;
const SUMMARY_POLL_MS = 1000;

/** A review run that `ask` answers questions about. */
export interface AskRun {
  id: string;
  paths: RunDir;
  run: RunRecord;
}

export async function loadAskRun(root: string): Promise<AskRun> {
  const paths = runDirPaths(root);
  const run = await readJsonOrNull<RunRecord & { kind?: string }>(paths.runJsonPath);
  if (run === null) throw new Error(`No run.json in ${root}`);
  if (run.kind === "eval") throw new Error("This is an eval run; ask about one of its cases.");
  return { id: path.basename(root), paths, run };
}

/** The run's process is still reviewing. A `running` run whose process is gone was killed. */
export function isRunning(run: RunRecord): boolean {
  return run.status === "running" && run.pid !== undefined && isAlive(run.pid);
}

/** Review runs under `.review-flow/runs/`, oldest first (run ids start with their timestamp). */
export async function listReviewRuns(repo: string): Promise<AskRun[]> {
  const ids = await readdir(runsPath(repo)).catch(() => [] as string[]);
  const runs: AskRun[] = [];
  for (const id of ids.toSorted()) {
    try {
      runs.push(await loadAskRun(path.join(runsPath(repo), id)));
    } catch {
      // An eval run, or not a run dir.
    }
  }
  return runs;
}

/** Where the findings are, read again before each question. */
export type FindingsState =
  | { state: "skipped" }
  | { state: "pending" }
  | { state: "verifying"; findings: number }
  | { state: "done"; findings: number; verdicts: VerdictCounts }
  | { state: "failed"; error: string };

export interface FindingsSnapshot {
  state: FindingsState;
  findings: NormalizedFinding[];
  verdicts: Record<string, Verdict>;
}

export async function readFindings(paths: RunDir): Promise<FindingsSnapshot> {
  const run = await readJsonOrNull<RunRecord>(paths.runJsonPath);
  const findings = await readJsonOrNull<NormalizedFinding[]>(paths.findingsPath);
  const verdicts = await readJsonOrNull<Record<string, Verdict>>(paths.verdictsPath);
  const snapshot = (state: FindingsState): FindingsSnapshot => ({
    state,
    findings: findings ?? [],
    verdicts: verdicts ?? {},
  });
  if (run?.find === false) return snapshot({ state: "skipped" });
  if (findings !== null && verdicts !== null) {
    return snapshot({
      state: "done",
      findings: findings.length,
      verdicts: countVerdicts(verdicts),
    });
  }
  if (run !== null && isRunning(run)) {
    return snapshot(
      findings === null ? { state: "pending" } : { state: "verifying", findings: findings.length },
    );
  }
  const error =
    run?.status === "running" ? "the review was stopped" : (run?.error ?? "no findings were saved");
  return snapshot({ state: "failed", error });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `3 findings: 2 confirmed, 1 refuted`, `pending, the review is still running`, … */
export function describeFindings(state: FindingsState): string {
  switch (state.state) {
    case "skipped":
      return "not looked for (summary-only run)";
    case "pending":
      return "pending, the review is still running";
    case "verifying":
      return `${plural(state.findings, "finding")}, verification pending`;
    case "failed":
      return `none, the review failed (${state.error})`;
    case "done": {
      if (state.findings === 0) return "none";
      const counts = (["confirmed", "inconclusive", "refuted"] as const)
        .filter((kind) => state.verdicts[kind] > 0)
        .map((kind) => `${state.verdicts[kind]} ${kind}`);
      return `${plural(state.findings, "finding")}: ${counts.join(", ")}`;
    }
  }
}

function sameState(a: FindingsState, b: FindingsState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The run's summary, waiting while the summarizer is still running. null when the run skipped it;
 * `failed` when the summarizer failed or the run ended without one.
 */
export async function waitForSummary(
  ask: AskRun,
  signal?: AbortSignal,
): Promise<SummaryOutcome | null> {
  for (;;) {
    const summary = await readJsonOrNull<Summary>(ask.paths.summaryPath);
    if (summary !== null) return { status: "ok", summary };
    const run = (await readJsonOrNull<RunRecord>(ask.paths.runJsonPath)) ?? ask.run;
    if (run.summarize === false) return null;
    const summarizer = (await readCalls(ask.paths)).find((call) => call.role === "summarizer");
    // An ok call is followed by summary.json, so only a failed one ends the wait.
    if (summarizer !== undefined && summarizer.status !== "ok") {
      return {
        status: "failed",
        error: `${summarizer.status}: ${summarizer.error ?? "no output"}`,
      };
    }
    if (!isRunning(run)) {
      return { status: "failed", error: run.error ?? "the run ended without a summary" };
    }
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, SUMMARY_POLL_MS));
  }
}

async function readCalls(paths: RunDir): Promise<CallRecord[]> {
  const text = await readFile(paths.callsPath, "utf8").catch(() => "");
  return text.split("\n").flatMap((line) => {
    try {
      return line.trim() === "" ? [] : [JSON.parse(line) as CallRecord];
    } catch {
      return [];
    }
  });
}

export function runChange(run: RunRecord): ChangeRange {
  return changeRangeOf(run.base.ref, {
    pr: run.pr,
    uncommitted: run.head.snapshotSha !== undefined,
  });
}

/** One question and its answer, for follow-ups. */
export interface Exchange {
  question: string;
  answer: string;
}

/** Newest exchanges that fit in MAX_HISTORY_CHARS, oldest first. */
export function describeHistory(history: readonly Exchange[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const { question, answer } of history.toReversed()) {
    const text = `**Question:** ${question}\n\n**Your answer:**\n\n${answer}`;
    if (size + text.length > MAX_HISTORY_CHARS) break;
    kept.unshift(text);
    size += text.length;
  }
  if (kept.length === 0) return "This is the first question.";
  const dropped = history.length - kept.length;
  return [
    ...(dropped > 0 ? [`(${plural(dropped, "earlier exchange")} left out.)`] : []),
    ...kept,
  ].join("\n\n---\n\n");
}

/** Findings with their verdicts, highest-ranked first, fenced as agent-written data. */
export function describeFindingsForPrompt(snapshot: FindingsSnapshot): string {
  const { state, findings, verdicts } = snapshot;
  switch (state.state) {
    case "skipped":
      return "This run did not look for defects.";
    case "pending":
      return "Not ready yet: the review is still looking for defects. If the question depends on them, say so.";
    case "failed":
      return `None: the review failed before reporting findings (${state.error}).`;
    case "verifying":
    case "done":
      if (findings.length === 0) return "The review found no defects.";
  }
  const items =
    state.state === "done"
      ? rankFindings(
          findings.flatMap((finding) => {
            const verdict = verdicts[finding.id];
            return verdict === undefined ? [] : [{ finding, verdict }];
          }),
        ).map(
          ({ finding, verdict }) =>
            `- ${finding.id} [${verdict.verdict}, ${verdict.severity}] ${formatLocation(finding)}: ${finding.title}\n` +
            `  Claim: ${finding.claim}\n  Verifier: ${verdict.summary}`,
        )
      : findings.map(
          (finding) =>
            `- ${finding.id} [not verified yet] ${formatLocation(finding)}: ${finding.title}\n  Claim: ${finding.claim}`,
        );
  return codeFence(items.join("\n"));
}

export interface AnswererInput {
  change: ChangeRange;
  intent: Intent | null;
  summary: SummaryOutcome | null;
  trust: TrustLevel;
  findings: FindingsSnapshot;
  history: readonly Exchange[];
  /** Set when the checkout no longer matches what was reviewed. */
  drift: string | null;
}

function answererVars(input: AnswererInput): Record<string, string> {
  const { summary } = input;
  return {
    ...input.change,
    checkout:
      input.drift === null
        ? "The files are the reviewed version of the code."
        : `${input.drift} Answer from the files as they are now, and say when they differ from the diff.`,
    intent: input.intent === null ? "None saved with this run." : describeIntent(input.intent),
    summary:
      summary === null
        ? "None: the run skipped it."
        : summary.status === "failed"
          ? `None: the summarizer failed (${summary.error}).`
          : codeFence(renderSummary(summary.summary, input.trust)),
    findings: describeFindingsForPrompt(input.findings),
    history: describeHistory(input.history),
  };
}

export function buildAnswererPrompt(
  template: string,
  input: AnswererInput,
  question: string,
): string {
  return (
    renderPrompt(template, { ...answererVars(input), question }).trimEnd() +
    "\n\nYour final answer must be a single JSON object matching the required schema, with the Markdown answer in `answer`.\n"
  );
}

/** The context for `ask --open`: the diff, then the answerer's instructions with no question yet. */
export function buildOpenContext(
  template: string,
  sharedContext: string,
  input: AnswererInput,
): string {
  const prompt = renderPrompt(template, {
    ...answererVars(input),
    question: "The developer asks their questions in this chat. Answer each one as below.",
  });
  return `${sharedContext.trimEnd()}\n\n${prompt}`;
}

/** A line of asks.jsonl. `ask --open` sessions have no question or answer. */
export interface AskRecord {
  askedAt: string;
  taskId: string;
  harness: Harness;
  model: string | null;
  question: string | null;
  answer: string | null;
  status: AgentStatus;
  error: string | null;
  costUsd: number | null;
  costSource: CostSource;
  durationMs: number;
  findings: FindingsState["state"];
}

export interface AskSessionOptions {
  ask: AskRun;
  checkout: AskCheckout;
  harness: Harness;
  model: ModelChoice;
  runAgent: RunAgent;
  log: (message: string) => void;
  onActivity: (activity: TaskActivity) => void;
  verbose: boolean;
}

export interface AskOutcome {
  /** null when the answerer failed. */
  answer: string | null;
  error: string | null;
  costUsd: number | null;
  costSource: CostSource;
  durationMs: number;
  /** The findings' state when it changed since the session started or the last question. */
  findingsChanged: FindingsState | null;
}

/** Everything a question is answered with, read once per session; findings are read per question. */
export async function loadAnswererInput(ask: AskRun, drift: string | null) {
  const run = ask.run;
  const change = runChange(run);
  const diff = await readFile(ask.paths.diffPath, "utf8");
  return {
    template: await loadPrompt("answerer"),
    sharedContext: buildChangeContext(await loadPrompt("change"), change, diff),
    input: async (history: readonly Exchange[]): Promise<AnswererInput> => ({
      change,
      intent: await readJsonOrNull<Intent>(ask.paths.intentPath),
      summary: await waitForSummary(ask),
      trust: (run.trust ?? (run.pr === undefined ? { level: "own" } : prTrust(run.pr))).level,
      findings: await readFindings(ask.paths),
      history,
      drift,
    }),
  };
}

/**
 * A question loop over one run: each question is one headless call with the earlier questions and
 * answers in the prompt, so no agent session is kept. The diff is shared context, so follow-ups
 * read it from cache.
 */
export async function createAskSession(options: AskSessionOptions) {
  const { ask, checkout, harness, model } = options;
  const loaded = await loadAnswererInput(ask, checkout.drift);
  const history: Exchange[] = [];
  let shown = (await readFindings(ask.paths)).state;
  let asked = 0;
  return {
    findings: shown,
    async ask(question: string): Promise<AskOutcome> {
      const input = await loaded.input(history);
      const changed = sameState(input.findings.state, shown) ? null : input.findings.state;
      shown = input.findings.state;
      await checkout.ensure();
      const ctx: TaskContext = {
        runDir: ask.paths,
        repo: checkout.dir,
        status: await snapshotStatus(checkout.dir),
        harness,
        calls: [],
        runAgent: options.runAgent,
        log: options.log,
        onActivity: options.onActivity,
        verbose: options.verbose,
      };
      const taskId = `ask-${process.pid}-${++asked}`;
      const result = await runTask(
        {
          taskId,
          role: "answerer",
          prompt: buildAnswererPrompt(loaded.template, input, question),
          sharedContext: loaded.sharedContext,
          cwd: checkout.dir,
          schema: Answer,
          model: model.model,
          effort: model.effort,
          timeoutMs: ANSWERER_TIMEOUT_MS,
        },
        "ask",
        ctx,
      );
      const answer = result.output?.answer.trim() ?? null;
      if (answer !== null) history.push({ question, answer });
      const { call } = result;
      await appendAsk(ask.paths, {
        askedAt: call.startedAt,
        taskId,
        harness,
        model: model.model,
        question,
        answer,
        status: call.status,
        error: call.error,
        costUsd: call.costUsd,
        costSource: call.costSource,
        durationMs: call.durationMs,
        findings: input.findings.state.state,
      });
      return {
        answer,
        error: answer === null ? `${call.status}: ${call.error ?? "no output"}` : null,
        costUsd: call.costUsd,
        costSource: call.costSource,
        durationMs: call.durationMs,
        findingsChanged: changed,
      };
    },
  };
}

export async function appendAsk(paths: RunDir, record: AskRecord): Promise<void> {
  await appendFile(paths.asksPath, `${JSON.stringify(record)}\n`);
}

/** Records an `ask --open` session: its cost is unknown, since the interactive CLI doesn't report it. */
export async function recordOpen(
  paths: RunDir,
  fields: {
    harness: Harness;
    model: ModelChoice;
    startedAt: Date;
    durationMs: number;
    error: string | null;
    findings: FindingsState;
  },
): Promise<void> {
  const taskId = `ask-open-${process.pid}`;
  const status: AgentStatus = fields.error === null ? "ok" : "error";
  const call: CallRecord = {
    taskId,
    role: "answerer",
    step: "ask",
    harness: fields.harness,
    model: fields.model.model,
    effort: fields.model.effort,
    status,
    error: fields.error,
    usage: null,
    costUsd: null,
    costSource: "unknown",
    startedAt: fields.startedAt.toISOString(),
    durationMs: fields.durationMs,
    outsideReads: [],
  };
  await appendFile(paths.callsPath, `${JSON.stringify(call)}\n`);
  await appendAsk(paths, {
    askedAt: call.startedAt,
    taskId,
    harness: fields.harness,
    model: fields.model.model,
    question: null,
    answer: null,
    status,
    error: fields.error,
    costUsd: null,
    costSource: "unknown",
    durationMs: fields.durationMs,
    findings: fields.findings.state,
  });
}

/** The checkout `ask` reads: the developer's own, or the run's worktree under a lease. */
export interface AskCheckout {
  dir: string;
  /** Whether `dir` is a review worktree held by this process's lease. */
  worktree: boolean;
  /** Why the files may differ from what was reviewed; null when they match. */
  drift: string | null;
  /** Re-creates the worktree if it went missing; call before each question. */
  ensure(): Promise<void>;
  /** Drops the lease; the last `ask` out, after the review, removes the worktree. */
  release(): Promise<void>;
  releaseSync(): void;
}

/** Why the developer's checkout differs from what the run reviewed, or null. */
async function checkoutDrift(dir: string, run: RunRecord): Promise<string | null> {
  const head = await resolveCommit(dir, "HEAD");
  if (head !== run.head.sha) {
    return `HEAD has moved since the review (reviewed ${run.head.sha.slice(0, 7)}, now ${head.slice(0, 7)}).`;
  }
  const snapshot = await snapshotWorkingTree(dir);
  const reviewed = await treeOf(dir, run.head.snapshotSha ?? run.head.sha);
  const current = await treeOf(dir, snapshot?.sha ?? "HEAD");
  return reviewed === current ? null : "The uncommitted changes differ from the reviewed snapshot.";
}

/**
 * Opens the run's checkout without fetching. Current-branch runs use the developer's checkout and
 * report drift. Other runs reuse the run's worktree under a lease, or add one at the reviewed
 * commit from local objects.
 */
export async function openCheckout(repo: string, ask: AskRun): Promise<AskCheckout> {
  const { run } = ask;
  const root = worktreesDir(repo);
  const recorded = run.checkout;
  const inWorktree =
    recorded === undefined
      ? run.pr !== undefined
      : !path.relative(root, recorded).startsWith("..") && recorded !== repo;
  if (!inWorktree) {
    const dir = recorded ?? repo;
    const noop = async () => {};
    return {
      dir,
      worktree: false,
      drift: await checkoutDrift(dir, run),
      ensure: noop,
      release: noop,
      releaseSync() {},
    };
  }

  const own = path.join(root, `ask-${ask.id}`);
  // A worktree's `.git` is a file pointing at the main repo's git dir.
  const isWorktree = (dir: string) =>
    stat(path.join(dir, ".git")).then(
      () => true,
      () => false,
    );
  let dir = recorded !== undefined && (await isWorktree(recorded)) ? recorded : own;
  // Taken before checking, so a review ending now leaves the worktree in place.
  let lease = await takeLease(ask.paths.leasesDir, dir);
  const sha = run.head.snapshotSha ?? run.head.sha;
  const ensure = async () => {
    if (await isWorktree(dir)) return;
    if (dir !== own) {
      await lease.release();
      dir = own;
      lease = await takeLease(ask.paths.leasesDir, dir);
      if (await isWorktree(dir)) return;
    }
    if (!(await hasCommit(repo, sha))) {
      throw new Error(
        `The reviewed commit ${sha.slice(0, 7)} is no longer in the repo; run the review again.`,
      );
    }
    await ensureStateDir(repo);
    await createReviewWorktree(repo, sha, path.basename(own));
  };
  try {
    await ensure();
  } catch (error) {
    await lease.release();
    throw error;
  }
  const reviewing = () => {
    try {
      return isRunning(JSON.parse(readFileSync(ask.paths.runJsonPath, "utf8")) as RunRecord);
    } catch {
      return false;
    }
  };
  return {
    get dir() {
      return dir;
    },
    worktree: true,
    drift: null,
    ensure,
    // A running review removes the worktree itself when it ends, unless leased.
    release: async () => {
      await lease.release();
      if (!reviewing()) await reviewWorktree(repo, dir).remove();
    },
    releaseSync: () => {
      lease.releaseSync();
      if (!reviewing()) reviewWorktree(repo, dir).removeSync();
    },
  };
}
