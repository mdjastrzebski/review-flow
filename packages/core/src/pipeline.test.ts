import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import { WorkingTreeChangedError } from "./git.ts";
import { DEFAULT_MODELS } from "./models.ts";
import { runReview } from "./pipeline.ts";
import type { ReviewOutput } from "./schemas.ts";

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

const output: ReviewOutput = {
  findings: [
    {
      localId: "1",
      title: "Adds b",
      file: "a.txt",
      lineStart: 2,
      lineEnd: 2,
      category: "correctness",
      severity: "low",
      claim: "c",
      rationale: "r",
      suggestedFix: null,
    },
  ],
};

function stubAgent(effect: (task: AgentTask<unknown>) => Promise<void> = async () => {}): {
  runAgent: RunAgent;
  tasks: AgentTask<unknown>[];
} {
  const tasks: AgentTask<unknown>[] = [];
  const runAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    tasks.push(task as AgentTask<unknown>);
    await effect(task as AgentTask<unknown>);
    return {
      status: "ok",
      output: task.schema.parse(output),
      rawText: JSON.stringify(output),
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
    expect(run).toMatchObject({ status: "ok", costUsd: 0.5, base: { ref: "main" } });
    expect(run.tasks).toHaveLength(1);
  });

  it("aborts when an agent changes the working tree", async () => {
    const { runAgent } = stubAgent(async () => {
      await writeFile(path.join(repo, "a.txt"), "tampered\n");
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
