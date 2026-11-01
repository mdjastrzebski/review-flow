import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import type { CallRecord } from "./calls.ts";
import { WorkingTreeChangedError } from "./git.ts";
import { DEFAULT_MODELS } from "./models.ts";
import { NoChangesError, runReview } from "./pipeline.ts";
import { readIndex } from "./run-index.ts";
import type { Finding, ReviewOutput, Verdict } from "./schemas.ts";

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

const output: ReviewOutput = { findings: [makeFinding("1")] };

const confirmed: Verdict = {
  verdict: "confirmed",
  severity: "medium",
  confidence: "high",
  fixCost: "trivial",
  evidence: [{ kind: "code_ref", file: "a.txt", line: 2, detail: "here" }],
  summary: "s",
  fix: { assessment: "not_applicable", detail: "d", betterFix: "do it" },
};

interface StubOptions {
  review?: ReviewOutput;
  /** Verifier answer; null makes the verifier fail with invalid_output. */
  verdict?: (task: AgentTask<unknown>) => Verdict | null;
  effect?: (task: AgentTask<unknown>) => Promise<void>;
}

function stubAgent({
  review = output,
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
    const answer = task.role === "reviewer" ? review : verdict(task as AgentTask<unknown>);
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
  log: () => {},
};

describe("runReview", () => {
  it("writes the prompt, raw output, findings and run.json", async () => {
    const { runAgent, tasks } = stubAgent();
    const { runDir, findings } = await runReview({ ...baseOptions, cwd: repo, runAgent });

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
      expect.objectContaining({ taskId: "verifier-F-001", step: "verify", effort: "high" }),
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

  it("computes the cost from tokens when a task reports none", async () => {
    const { runAgent: base } = stubAgent();
    const runAgent: RunAgent = async (task) => ({ ...(await base(task)), costUsd: null });
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
    const review = { findings: ["1", "2", "3", "4", "5"].map(makeFinding) };
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
      models: { ...DEFAULT_MODELS.claude, verifier: { model: "other-model", effort: "low" } },
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

  it("starts other verifiers only once the first one shows activity", async () => {
    const review = { findings: ["1", "2", "3"].map(makeFinding) };
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
    const review = { findings: ["1", "2"].map(makeFinding) };
    const { runAgent } = stubAgent({
      review,
      verdict: (task) => (task.taskId === "verifier-F-001" ? { ...confirmed, evidence: [] } : null),
    });
    const { runDir, verdicts } = await runReview({ ...baseOptions, cwd: repo, runAgent });

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
    const review = { findings: ["1", "2", "3", "4", "5", "6"].map(makeFinding) };
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
    const review = { findings: ["1", "2", "3"].map(makeFinding) };
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
          task.signal?.addEventListener("abort", () => resolve(), { once: true });
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
      expect.objectContaining({ id: runName, status: "failed", findings: null, verdicts: null }),
    ]);
  });

  it("fails with a clear error on an empty diff", async () => {
    const { runAgent, tasks } = stubAgent();
    await expect(
      runReview({ ...baseOptions, base: "feature", cwd: repo, runAgent }),
    ).rejects.toBeInstanceOf(NoChangesError);
    expect(tasks).toHaveLength(0);
  });
});
