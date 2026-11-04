import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import type { CallRecord } from "./calls.ts";
import { WorkingTreeChangedError } from "./git.ts";
import type { PullRequest } from "./github.ts";
import { DEFAULT_MODELS } from "./models.ts";
import { DeclinedError, NoChangesError, runReview, type Preflight } from "./pipeline.ts";
import { ensureStateDir } from "./run-dir.ts";
import { readIndex } from "./run-index.ts";
import {
  FindingsOutput,
  type CheckedRoughEdge,
  type Finding,
  type ReviewOutput,
  type RoughEdge,
  type RoughEdgeChecks,
  type Summary,
  type Verdict,
} from "./schemas.ts";
import { OWN_CHECKOUT, type Trust } from "./trust.ts";
import { createReviewWorktree } from "./worktree.ts";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "review-flow-pipeline-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(path.join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("switch", "-qc", "feature");
  await writeFile(path.join(repo, "a.txt"), "a\nb\n");
  git("commit", "-qam", "change");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeFinding(localId: string): Finding {
  return {
    localId,
    title: `Finding ${localId}`,
    file: "a.txt",
    lineStart: 2,
    lineEnd: 2,
    category: "correctness",
    severity: "low",
    claim: "c",
    rationale: "r",
    suggestedFix: null,
  };
}

const output: ReviewOutput = { findings: [makeFinding("1")], roughEdges: [] };

const confirmed: Verdict = {
  verdict: "confirmed",
  severity: "medium",
  confidence: "high",
  fixCost: "trivial",
  evidence: [{ kind: "code_ref", file: "a.txt", line: 2, detail: "here" }],
  summary: "s",
  fix: { assessment: "not_applicable", detail: "d", betterFix: "do it" },
};

const summary: Summary = {
  goal: { text: "Add b.", source: "stated" },
  changes: ["Adds b to a.txt."],
  achieved: { verdict: "yes", gaps: [], extras: [] },
  lookAt: [{ file: "a.txt", line: 2, detail: "New line." }],
};

interface StubOptions {
  review?: ReviewOutput | FindingsOutput;
  /** Summarizer answer; null makes the summarizer fail with invalid_output. */
  summary?: Summary | null;
  /** Verifier answer; null makes the verifier fail with invalid_output. */
  verdict?: (task: AgentTask<unknown>) => Verdict | null;
  effect?: (task: AgentTask<unknown>) => Promise<void>;
}

function stubAgent({
  review = output,
  summary: summaryAnswer = summary,
  verdict = () => confirmed,
  effect = async () => {},
}: StubOptions = {}): {
  runAgent: RunAgent;
  tasks: AgentTask<unknown>[];
} {
  const tasks: AgentTask<unknown>[] = [];
  const runAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    tasks.push(task as AgentTask<unknown>);
    await effect(task as AgentTask<unknown>);
    const answer =
      task.role === "reviewer"
        ? review
        : task.role === "summarizer"
          ? summaryAnswer
          : verdict(task as AgentTask<unknown>);
    if (answer === null) {
      return {
        status: "invalid_output",
        output: null,
        rawText: "nope",
        raw: { stub: true },
        error: "bad json",
        costUsd: 0.25,
        usage: null,
        durationMs: 10,
      };
    }
    return {
      status: "ok",
      output: task.schema.parse(answer),
      rawText: JSON.stringify(answer),
      raw: { stub: true },
      error: null,
      costUsd: 0.5,
      usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
      durationMs: 10,
    };
  };
  return { runAgent, tasks };
}

async function readCalls(file: string): Promise<CallRecord[]> {
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  return lines.map((line) => JSON.parse(line) as CallRecord);
}

const baseOptions = {
  base: "main",
  harness: "claude" as const,
  models: DEFAULT_MODELS.claude,
  trust: OWN_CHECKOUT,
  log: () => {},
  // Most tests are about Find; the summary has its own tests below.
  summarize: false,
};

describe("runReview", () => {
  it("writes run.json as running, with its checkout and intent, while agents work", async () => {
    let during: Record<string, unknown> | null = null;
    let runRoot = "";
    const { runAgent } = stubAgent({
      effect: async (task) => {
        if (task.role !== "reviewer") return;
        const runs = path.join(repo, ".review-flow", "runs");
        runRoot = path.join(runs, (await readdir(runs))[0]!);
        during = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8"));
      },
    });
    const { runDir, checkout } = await runReview({
      ...baseOptions,
      cwd: repo,
      runAgent,
    });

    expect(during).toMatchObject({
      status: "running",
      pid: process.pid,
      finishedAt: null,
      checkout: await realpath(repo),
      summarize: false,
      find: true,
    });
    expect(checkout).toBe(await realpath(repo));
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8"));
    expect(run).toMatchObject({ status: "ok", checkout: await realpath(repo) });
    expect(run.pid).toBeUndefined();
    expect(JSON.parse(await readFile(runDir.intentPath, "utf8"))).toEqual({
      kind: "commits",
      messages: ["change"],
      uncommitted: false,
    });
  });

  it("shows the checkout and the ask command in the review box", async () => {
    const { runAgent } = stubAgent();
    const tables: [string, (readonly [string, string])[]][] = [];
    const { runDir } = await runReview({
      ...baseOptions,
      cwd: repo,
      runAgent,
      askCommand: (id, a) => `review-flow ask ${id} --harness ${a.harness}`,
      logTable: (title, rows) => tables.push([title, [...rows]]),
    });
    const rows = new Map(tables.find(([title]) => title === "Review")![1]);
    expect(rows.get("Checkout")).toBe(await realpath(repo));
    expect(rows.get("Ask")).toBe(`review-flow ask ${path.basename(runDir.root)} --harness claude`);
  });

  it("writes the prompt, raw output, findings and run.json", async () => {
    const { runAgent, tasks } = stubAgent();
    const { runDir, findings } = await runReview({
      ...baseOptions,
      cwd: repo,
      runAgent,
    });

    expect(findings.map((f) => f.id)).toEqual(["F-001"]);
    expect(tasks[0]?.model).toBe("claude-sonnet-5-5");
    expect(tasks[0]?.effort).toBe("high");

    const prompt = await readFile(runDir.promptPath("reviewer"), "utf8");
    expect(prompt).toContain("+b");
    expect(JSON.parse(await readFile(runDir.rawPath("reviewer"), "utf8"))).toEqual({ stub: true });
    expect(JSON.parse(await readFile(runDir.findingsPath, "utf8"))).toHaveLength(1);

    const calls = await readCalls(runDir.callsPath);
    expect(calls).toEqual([
      expect.objectContaining({
        taskId: "reviewer",
        role: "reviewer",
        step: "review",
        harness: "claude",
        model: "claude-sonnet-5-5",
        effort: "high",
        status: "ok",
        usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
        costUsd: 0.5,
        costSource: "reported",
        durationMs: 10,
      }),
      expect.objectContaining({
        taskId: "verifier-F-001",
        step: "verify",
        effort: "high",
      }),
    ]);

    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8"));
    expect(run).toMatchObject({ status: "ok", base: { ref: "main" } });
    expect(Object.keys(run.steps)).toEqual(["collect", "review", "verify", "report"]);
    expect(run.steps.collect).toMatchObject({ calls: 0, costUsd: null });
    expect(run.steps.review).toMatchObject({ calls: 1, costUsd: 0.5 });
    expect(run.steps.verify).toMatchObject({ calls: 1, costUsd: 0.5 });
    expect(run.steps.verify.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.totals).toMatchObject({
      calls: 2,
      costUsd: 1,
      unknownCostCalls: 0,
      usage: { input: 2, cacheRead: 4, cacheWrite: 6, output: 8 },
    });
    expect(run.totals.durationMs).toBeGreaterThanOrEqual(run.steps.verify.durationMs);

    const report = await readFile(runDir.reportPath, "utf8");
    expect(report).toContain("### [ ] F-001 · medium · confirmed (high) · `a.txt:2`");
    expect(report).toContain("**Cost:** $1.00");

    expect(await readIndex(repo)).toEqual([
      {
        id: path.basename(runDir.root),
        kind: "review",
        startedAt: run.startedAt,
        durationMs: run.totals.durationMs,
        status: "ok",
        harness: "claude",
        models: DEFAULT_MODELS.claude,
        base: run.base,
        head: run.head,
        diff: { files: 1, additions: 1, deletions: 0 },
        findings: 1,
        verdicts: { confirmed: 1, inconclusive: 0, refuted: 0 },
        costUsd: 1,
        unknownCostCalls: 0,
      },
    ]);
  });

  it("reviews a PR worktree and keeps the run dir and index in the state repo", async () => {
    const { runAgent, tasks } = stubAgent();
    const pr: PullRequest = {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "Add b",
      host: "github.com",
      repo: "acme/app",
      baseBranch: "main",
      headSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
      isCrossRepository: false,
    };
    await ensureStateDir(repo);
    const worktree = await createReviewWorktree(repo, pr.headSha);
    try {
      const { runDir } = await runReview({
        ...baseOptions,
        cwd: worktree.dir,
        stateRepo: repo,
        pr,
        committedOnly: true,
        runAgent,
      });
      expect(runDir.root.startsWith(path.join(repo, ".review-flow", "runs"))).toBe(true);
      expect(tasks[0]?.cwd).toBe(await realpath(worktree.dir));
      expect(tasks[0]?.prompt).toContain("the head of PR #7");
      expect(JSON.parse(await readFile(runDir.runJsonPath, "utf8")).pr).toEqual(pr);
      expect(await readFile(runDir.reportPath, "utf8")).toContain("# Review: PR #7: Add b");
      expect((await readIndex(repo)).at(-1)).toMatchObject({ pr: 7 });
    } finally {
      await worktree.remove();
    }
  });

  it("computes the cost from tokens when a task reports none", async () => {
    const { runAgent: base } = stubAgent();
    const runAgent: RunAgent = async (task) => ({
      ...(await base(task)),
      costUsd: null,
    });
    const result = await runReview({ ...baseOptions, cwd: repo, runAgent });

    expect(result.costUsd).toBeGreaterThan(0);
    const calls = await readCalls(result.runDir.callsPath);
    expect(calls.map((c) => c.costSource)).toEqual(["computed", "computed"]);
  });

  it("records the cost as unknown without a reported cost or tokens", async () => {
    const { runAgent: base } = stubAgent();
    const runAgent: RunAgent = async (task) => ({
      ...(await base(task)),
      costUsd: null,
      usage: null,
    });
    const result = await runReview({ ...baseOptions, cwd: repo, runAgent });

    expect(result.costUsd).toBeNull();
    const run = JSON.parse(await readFile(result.runDir.runJsonPath, "utf8"));
    expect(run.totals).toMatchObject({ costUsd: null, unknownCostCalls: 2 });
    const calls = await readCalls(result.runDir.callsPath);
    expect(calls.map((c) => c.costSource)).toEqual(["unknown", "unknown"]);
    expect(await readFile(result.runDir.reportPath, "utf8")).not.toContain("Cost");
  });

  it("verifies every finding in a fresh task and writes verdicts.json", async () => {
    const review = {
      findings: ["1", "2", "3", "4", "5"].map(makeFinding),
      roughEdges: [],
    };
    let active = 0;
    let maxActive = 0;
    const { runAgent, tasks } = stubAgent({
      review,
      effect: async (task) => {
        if (task.role !== "verifier") return;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
      },
    });
    const { runDir, verdicts } = await runReview({
      ...baseOptions,
      models: {
        ...DEFAULT_MODELS.claude,
        verifier: { model: "other-model", effort: "low" },
      },
      cwd: repo,
      runAgent,
    });

    const verifiers = tasks.filter((t) => t.role === "verifier");
    expect(verifiers.map((t) => t.taskId).toSorted()).toEqual(
      ["F-001", "F-002", "F-003", "F-004", "F-005"].map((id) => `verifier-${id}`),
    );
    expect(verifiers.every((t) => t.model === "other-model" && t.effort === "low")).toBe(true);
    expect(maxActive).toBe(3);

    const onDisk = JSON.parse(await readFile(runDir.verdictsPath, "utf8"));
    expect(Object.keys(onDisk).toSorted()).toEqual(Object.keys(verdicts).toSorted());
    expect(Object.keys(onDisk)).toHaveLength(5);
    const prompt = await readFile(runDir.promptPath("verifier-F-002"), "utf8");
    expect(prompt).toContain("Finding 2");
  });

  it("gives verifiers the diff as shared context and keeps it out of their prompts", async () => {
    const { runAgent, tasks } = stubAgent();
    await runReview({ ...baseOptions, cwd: repo, runAgent });

    const [reviewer, verifier] = tasks;
    expect(reviewer?.sharedContext).toBeNull();
    expect(verifier?.sharedContext).toContain("+b");
    expect(verifier?.prompt).not.toContain("+b");
  });

  it("logs setup, agent details, and tokens only when verbose", async () => {
    const lines = async (verbose: boolean) => {
      const logged: string[] = [];
      const { runAgent } = stubAgent({
        effect: async (task) => task.onDetail?.("command: fake"),
      });
      await runReview({
        ...baseOptions,
        cwd: repo,
        runAgent,
        verbose,
        log: (m) => logged.push(m),
        // Its own run dir: two runs in the same second would share a name.
        runRoot: path.join(`${repo}-runs`, String(verbose)),
      });
      return logged;
    };
    await mkdir(`${repo}-runs`);
    const quiet = await lines(false);
    const verbose = await lines(true);
    await rm(`${repo}-runs`, { recursive: true });
    expect(quiet.some((line) => /command: fake|tokens:|^Diff:|^Steps:/.test(line))).toBe(false);
    expect(verbose).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Diff: 1 file\(s\), \+\d+ −\d+/),
        expect.stringMatching(/\[reviewer 0:\d\d\] prompt: \d+ chars → /),
        expect.stringMatching(/\[reviewer 0:\d\d\] command: fake$/),
        expect.stringMatching(
          /tokens: in 1 · cache read 2 · cache write 3 · out 4 · 0s · cost reported/,
        ),
        expect.stringMatching(/^Steps: collect \d+s · review \d+s · verify \d+s · report \d+s/),
      ]),
    );
  });

  it("starts other verifiers only once the first one shows activity", async () => {
    const review = {
      findings: ["1", "2", "3"].map(makeFinding),
      roughEdges: [],
    };
    const events: string[] = [];
    const { runAgent } = stubAgent({
      review,
      effect: async (task) => {
        if (task.role !== "verifier") return;
        events.push(`start ${task.taskId}`);
        if (task.taskId !== "verifier-F-001") return;
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("activity");
        task.onProgress({ tool: "Read", detail: null });
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    await runReview({ ...baseOptions, cwd: repo, runAgent });

    expect(events.slice(0, 2)).toEqual(["start verifier-F-001", "activity"]);
    expect(events).toHaveLength(4);
  });

  it("applies the verdict rules and marks failed verifiers inconclusive", async () => {
    const review = { findings: ["1", "2"].map(makeFinding), roughEdges: [] };
    const { runAgent } = stubAgent({
      review,
      verdict: (task) => (task.taskId === "verifier-F-001" ? { ...confirmed, evidence: [] } : null),
    });
    const { runDir, verdicts } = await runReview({
      ...baseOptions,
      cwd: repo,
      runAgent,
    });

    expect(verdicts["F-001"]?.verdict).toBe("inconclusive");
    expect(verdicts["F-002"]).toMatchObject({
      verdict: "inconclusive",
      severity: "low",
      summary: "Verification failed (invalid_output): bad json",
    });
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8"));
    expect(run.status).toBe("ok");
    const calls = await readCalls(runDir.callsPath);
    expect(calls.find((c) => c.taskId === "verifier-F-002")).toMatchObject({
      status: "invalid_output",
      error: "bad json",
      costUsd: 0.25,
    });
  });

  it("aborts when a verifier changes the working tree, without starting queued ones", async () => {
    const review = {
      findings: ["1", "2", "3", "4", "5", "6"].map(makeFinding),
      roughEdges: [],
    };
    const { runAgent, tasks } = stubAgent({
      review,
      effect: async (task) => {
        if (task.taskId === "verifier-F-002") {
          await writeFile(path.join(repo, "a.txt"), "tampered\n");
        }
      },
    });
    await expect(runReview({ ...baseOptions, cwd: repo, runAgent })).rejects.toBeInstanceOf(
      WorkingTreeChangedError,
    );
    expect(tasks.filter((t) => t.role === "verifier").length).toBeLessThan(6);
  });

  it("signals in-flight verifiers to stop when the working tree changes", async () => {
    const review = {
      findings: ["1", "2", "3"].map(makeFinding),
      roughEdges: [],
    };
    const { runAgent, tasks } = stubAgent({
      review,
      effect: async (task) => {
        if (task.taskId === "verifier-F-002") {
          await writeFile(path.join(repo, "a.txt"), "tampered\n");
          return;
        }
        if (task.role !== "verifier") return;
        // Releases the verifiers waiting for the first one's cache write.
        task.onProgress({ tool: "Read", detail: null });
        // Stands in for a long session: only ends once the pipeline aborts it.
        await new Promise<void>((resolve) => {
          task.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    });
    await expect(runReview({ ...baseOptions, cwd: repo, runAgent })).rejects.toBeInstanceOf(
      WorkingTreeChangedError,
    );
    const verifiers = tasks.filter((t) => t.role === "verifier");
    expect(verifiers).toHaveLength(3);
    expect(verifiers.every((t) => t.signal?.aborted)).toBe(true);
  });

  it("aborts when an agent changes the working tree, keeping the records", async () => {
    const { runAgent } = stubAgent({
      effect: async () => {
        await writeFile(path.join(repo, "a.txt"), "tampered\n");
      },
    });
    await expect(runReview({ ...baseOptions, cwd: repo, runAgent })).rejects.toBeInstanceOf(
      WorkingTreeChangedError,
    );

    const runsDir = path.join(repo, ".review-flow", "runs");
    const [runName] = await readdir(runsDir);
    const root = path.join(runsDir, runName ?? "");
    const run = JSON.parse(await readFile(path.join(root, "run.json"), "utf8"));
    expect(run.status).toBe("failed");
    expect(Object.keys(run.steps)).toEqual(["collect", "review"]);
    expect(run.totals).toMatchObject({ calls: 1, costUsd: 0.5 });
    expect(await readCalls(path.join(root, "calls.jsonl"))).toHaveLength(1);
    expect(await readIndex(repo)).toEqual([
      expect.objectContaining({
        id: runName,
        status: "failed",
        findings: null,
        verdicts: null,
      }),
    ]);
  });

  it("reviews uncommitted changes through a snapshot, leaving the index alone", async () => {
    await writeFile(path.join(repo, "a.txt"), "a\nb\nc\n");
    await writeFile(path.join(repo, "new.txt"), "new\n");
    const { runAgent, tasks } = stubAgent();
    const { runDir } = await runReview({ ...baseOptions, cwd: repo, runAgent });

    const diff = await readFile(runDir.diffPath, "utf8");
    expect(diff).toContain("+c");
    expect(diff).toContain("+new");
    expect(tasks[0]?.prompt).toContain("`HEAD` plus uncommitted changes");
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8"));
    expect(run.head.snapshotSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.head.snapshotSha).not.toBe(run.head.sha);
    // The developer's index still has nothing staged.
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: repo,
      }).toString(),
    ).toBe("");
  });

  it("reviews HEAD only with committedOnly", async () => {
    await writeFile(path.join(repo, "a.txt"), "a\nb\nc\n");
    const { runAgent, tasks } = stubAgent();
    const { runDir } = await runReview({
      ...baseOptions,
      cwd: repo,
      runAgent,
      committedOnly: true,
    });

    expect(await readFile(runDir.diffPath, "utf8")).not.toContain("+c");
    expect(tasks[0]?.prompt).not.toContain("uncommitted");
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8"));
    expect(run.head.snapshotSha).toBeUndefined();
  });

  it("reviews uncommitted changes on a branch with no commits of its own", async () => {
    git("switch", "-q", "main");
    await writeFile(path.join(repo, "a.txt"), "a\nz\n");
    const { runAgent } = stubAgent();
    const { runDir } = await runReview({ ...baseOptions, cwd: repo, runAgent });

    expect(await readFile(runDir.diffPath, "utf8")).toContain("+z");
  });

  it("fails with a clear error on an empty diff", async () => {
    const { runAgent, tasks } = stubAgent();
    await expect(
      runReview({ ...baseOptions, base: "feature", cwd: repo, runAgent }),
    ).rejects.toBeInstanceOf(NoChangesError);
    expect(tasks).toHaveLength(0);
  });
});

describe("runReview summary", () => {
  const withSummary = { ...baseOptions, summarize: true };

  it("runs the summarizer next to the reviewer and writes summary.json and the report", async () => {
    git("commit", "-q", "--allow-empty", "-m", "Second commit", "-m", "With a body.");
    const { runAgent, tasks } = stubAgent();
    const result = await runReview({ ...withSummary, cwd: repo, runAgent });

    const summarizer = tasks.find((t) => t.role === "summarizer");
    expect(summarizer).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    expect(summarizer?.sharedContext).toContain("+b");
    expect(summarizer?.sharedContext).toBe(tasks.find((t) => t.role === "verifier")?.sharedContext);
    expect(summarizer?.prompt).toContain("Commit messages, oldest first:");
    expect(summarizer?.prompt).toMatch(/change\n\n---\n\nSecond commit\n\nWith a body\./);
    expect(summarizer?.prompt).not.toContain("+b");

    expect(result.summary).toEqual({ status: "ok", summary });
    expect(JSON.parse(await readFile(result.runDir.summaryPath, "utf8"))).toEqual(summary);
    const run = JSON.parse(await readFile(result.runDir.runJsonPath, "utf8"));
    expect(run.steps.summarize).toMatchObject({ calls: 1, costUsd: 0.5 });
    expect(run.totals.calls).toBe(3);
    const report = await readFile(result.runDir.reportPath, "utf8");
    expect(report.indexOf("## Summary")).toBeLessThan(report.indexOf("### [ ] F-001"));
  });

  it("gives the summarizer the PR description", async () => {
    const { runAgent, tasks } = stubAgent();
    const pr: PullRequest = {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "Add b",
      host: "github.com",
      repo: "acme/app",
      baseBranch: "main",
      headSha: "x",
      isCrossRepository: false,
    };
    await runReview({
      ...withSummary,
      cwd: repo,
      runAgent,
      pr,
      prBody: "Fixes ``` #3",
    });
    const prompt = tasks.find((t) => t.role === "summarizer")?.prompt;
    expect(prompt).toContain(
      "Title and description of PR #7:\n\n````\nAdd b\n\nFixes ``` #3\n````",
    );
  });

  it("goes on without a summary when the summarizer fails", async () => {
    const { runAgent } = stubAgent({ summary: null });
    const result = await runReview({ ...withSummary, cwd: repo, runAgent });

    expect(result.summary).toEqual({
      status: "failed",
      error: "invalid_output: bad json",
    });
    expect(result.findings).toHaveLength(1);
    await expect(readFile(result.runDir.summaryPath)).rejects.toThrow();
    expect(await readFile(result.runDir.reportPath, "utf8")).toContain("Summary missing");
  });

  it("summarizes only, without Find, when find is off", async () => {
    const { runAgent, tasks } = stubAgent();
    const result = await runReview({
      ...withSummary,
      find: false,
      cwd: repo,
      runAgent,
    });

    expect(tasks.map((t) => t.role)).toEqual(["summarizer"]);
    expect(result.summary?.status).toBe("ok");
    const run = JSON.parse(await readFile(result.runDir.runJsonPath, "utf8"));
    expect(Object.keys(run.steps)).toEqual(["collect", "summarize", "report"]);
    const report = await readFile(result.runDir.reportPath, "utf8");
    expect(report).toContain("## Summary");
    expect(report).not.toContain("finding");
    expect((await readIndex(repo)).at(-1)).toMatchObject({
      findings: null,
      verdicts: null,
    });
  });

  it("fails a summary-only run when the summarizer fails", async () => {
    const { runAgent } = stubAgent({ summary: null });
    await expect(runReview({ ...withSummary, find: false, cwd: repo, runAgent })).rejects.toThrow(
      "Summarizer failed (invalid_output: bad json)",
    );
  });

  it("stops the reviewer and reports the summarizer's error when it changes the tree", async () => {
    const { runAgent, tasks } = stubAgent({
      effect: async (task) => {
        if (task.role === "summarizer") {
          await writeFile(path.join(repo, "a.txt"), "tampered\n");
          return;
        }
        if (task.role !== "reviewer") return;
        await new Promise<void>((resolve) => {
          task.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    });
    await expect(runReview({ ...withSummary, cwd: repo, runAgent })).rejects.toBeInstanceOf(
      WorkingTreeChangedError,
    );
    expect(tasks.find((t) => t.role === "reviewer")?.signal?.aborted).toBe(true);
    expect(tasks.some((t) => t.role === "verifier")).toBe(false);
  });
});

describe("runReview trust", () => {
  const fork: Trust = { level: "external", reason: "fork PR" };

  it("records the trust level in run.json", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await runReview({ ...baseOptions, cwd: repo, runAgent });
    expect(JSON.parse(await readFile(runDir.runJsonPath, "utf8")).trust).toEqual(OWN_CHECKOUT);
  });

  it("asks before spending on an external target, with the diff size", async () => {
    const { runAgent, tasks } = stubAgent();
    const asked: Preflight[] = [];
    await expect(
      runReview({
        ...baseOptions,
        trust: fork,
        cwd: repo,
        runAgent,
        confirmSpend: async (preflight) => {
          asked.push(preflight);
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(DeclinedError);
    expect(asked).toEqual([
      {
        trust: fork,
        diff: { files: 1, additions: 1, deletions: 0 },
        estimate: null,
      },
    ]);
    expect(tasks).toEqual([]);
    await expect(readdir(path.join(repo, ".review-flow", "runs"))).rejects.toThrow();
  });

  it("doesn't ask for targets that aren't external", async () => {
    const { runAgent } = stubAgent();
    let asked = 0;
    await runReview({
      ...baseOptions,
      cwd: repo,
      runAgent,
      confirmSpend: async () => !!++asked,
    });
    expect(asked).toBe(0);
  });

  it("runs an external target once confirmed", async () => {
    const { runAgent, tasks } = stubAgent();
    const { runDir } = await runReview({
      ...baseOptions,
      trust: fork,
      cwd: repo,
      runAgent,
      confirmSpend: async () => true,
    });
    expect(tasks.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(runDir.runJsonPath, "utf8")).status).toBe("ok");
  });
  describe("rough edges", () => {
    const edge = (localId: string): RoughEdge => ({
      localId,
      title: `Edge ${localId}`,
      file: "a.txt",
      lineStart: 2,
      lineEnd: 2,
      lens: "design",
      observation: "o",
      suggestion: "s",
    });
    const withEdges: ReviewOutput = {
      findings: [],
      roughEdges: ["1", "2", "3"].map(edge),
    };
    const checks = (answer: RoughEdgeChecks) => () => answer as unknown as Verdict;
    const check = (localId: string, status: RoughEdgeChecks["checks"][number]["status"]) => ({
      localId,
      status,
      note: `n${localId}`,
    });

    it("checks all edges in one verifier session and saves them with their checks", async () => {
      const { runAgent, tasks } = stubAgent({
        review: withEdges,
        verdict: checks({
          checks: [
            check("R-001", "accurate"),
            check("R-002", "inaccurate"),
            check("R-003", "unclear"),
          ],
        }),
      });
      const result = await runReview({ ...baseOptions, cwd: repo, runAgent });

      expect(tasks.map((t) => t.taskId)).toEqual(["reviewer", "verifier-rough-edges"]);
      expect(tasks[1]!.sharedContext).toContain("diff");
      expect(result.roughEdges.map((e) => [e.id, e.check.status])).toEqual([
        ["R-001", "accurate"],
        ["R-002", "inaccurate"],
        ["R-003", "unclear"],
      ]);
      const saved = JSON.parse(
        await readFile(result.runDir.roughEdgesPath, "utf8"),
      ) as CheckedRoughEdge[];
      expect(saved).toHaveLength(3);
      const run = JSON.parse(await readFile(result.runDir.runJsonPath, "utf8"));
      expect(Object.keys(run.steps)).toEqual(["collect", "review", "verify", "check", "report"]);
      expect(run.steps.check).toMatchObject({ calls: 1 });
      expect(run.steps.verify).toMatchObject({ calls: 0 });
      const report = await readFile(result.runDir.reportPath, "utf8");
      expect(report).toContain("## Rough edges (2)");
      expect(report).not.toContain("R-002");
    });

    it("marks every edge unclear when the checker fails, without failing the run", async () => {
      const warnings: string[] = [];
      const { runAgent } = stubAgent({
        review: withEdges,
        verdict: () => null,
      });
      const result = await runReview({
        ...baseOptions,
        cwd: repo,
        runAgent,
        warn: (m) => warnings.push(m),
      });
      expect(result.roughEdges.map((e) => e.check.status)).toEqual([
        "unclear",
        "unclear",
        "unclear",
      ]);
      expect(warnings.join("\n")).toContain("Rough edge check failed");
    });

    it("runs no checker without rough edges", async () => {
      const { runAgent, tasks } = stubAgent({ review: { findings: [], roughEdges: [] } });
      await runReview({ ...baseOptions, cwd: repo, runAgent });
      expect(tasks.map((t) => t.taskId)).toEqual(["reviewer"]);
      expect(tasks[0]!.prompt).toContain("## Rough edges");
    });

    it("asks the reviewer for no rough edges when off", async () => {
      const off = stubAgent({ review: { findings: [] } });
      const result = await runReview({
        ...baseOptions,
        cwd: repo,
        runAgent: off.runAgent,
        roughEdges: false,
      });
      expect(off.tasks[0]!.prompt).not.toContain("## Rough edges");
      expect(off.tasks[0]!.schema).toBe(FindingsOutput);
      expect(off.tasks.map((t) => t.taskId)).toEqual(["reviewer"]);
      expect(result.roughEdges).toEqual([]);
    });
  });
});
