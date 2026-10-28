import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import { WorkingTreeChangedError } from "./git.ts";
import { DEFAULT_MODELS } from "./models.ts";
import { runReview } from "./pipeline.ts";
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
      durationMs: 10,
    };
  };
  return { runAgent, tasks };
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
    expect(tasks[0]?.model).toBe("claude-opus-5-5");
    expect(tasks[0]?.effort).toBe("high");

    const prompt = await readFile(runDir.promptPath("reviewer"), "utf8");
    expect(prompt).toContain("+b");
    expect(JSON.parse(await readFile(runDir.rawPath("reviewer"), "utf8"))).toEqual({ stub: true });
    expect(JSON.parse(await readFile(runDir.findingsPath, "utf8"))).toHaveLength(1);

    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8"));
    expect(run).toMatchObject({ status: "ok", costUsd: 1, base: { ref: "main" } });
    expect(run.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([
      "reviewer",
      "verifier-F-001",
    ]);
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
    expect(run.tasks.find((t: { taskId: string }) => t.taskId === "verifier-F-002")).toMatchObject({
      status: "invalid_output",
      error: "bad json",
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
        if (task.taskId === "verifier-F-001") {
          await writeFile(path.join(repo, "a.txt"), "tampered\n");
          return;
        }
        if (task.role !== "verifier") return;
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

  it("aborts when an agent changes the working tree", async () => {
    const { runAgent } = stubAgent({
      effect: async () => {
        await writeFile(path.join(repo, "a.txt"), "tampered\n");
      },
    });
    await expect(runReview({ ...baseOptions, cwd: repo, runAgent })).rejects.toBeInstanceOf(
      WorkingTreeChangedError,
    );
  });

  it("fails with a clear error on an empty diff", async () => {
    const { runAgent, tasks } = stubAgent();
    await expect(
      runReview({ ...baseOptions, base: "feature", cwd: repo, runAgent }),
    ).rejects.toThrow("No changes");
    expect(tasks).toHaveLength(0);
  });
});
