import { execFileSync } from "node:child_process";
import { readFile, realpath, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import {
  createAskSession,
  describeFindings,
  describeHistory,
  isRunning,
  listReviewRuns,
  loadAskRun,
  MAX_HISTORY_CHARS,
  openCheckout,
  readFindings,
  waitForSummary,
} from "./ask.ts";
import { DEFAULT_MODELS } from "./models.ts";
import { runReview, type RunRecord } from "./pipeline.ts";
import { writeJson } from "./json.ts";
import type { ReviewOutput, Summary, Verdict } from "./schemas.ts";
import { OWN_CHECKOUT } from "./trust.ts";
import { worktreesDir } from "./worktree.ts";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(tmpdir(), "review-flow-ask-")));
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

const review: ReviewOutput = {
  roughEdges: [],
  findings: [
    {
      localId: "1",
      title: "Off by one",
      file: "a.txt",
      lineStart: 2,
      lineEnd: 2,
      category: "correctness",
      severity: "low",
      claim: "b is wrong",
      rationale: "r",
      suggestedFix: null,
    },
  ],
};

const verdict: Verdict = {
  verdict: "confirmed",
  severity: "medium",
  confidence: "high",
  fixCost: "trivial",
  evidence: [{ kind: "code_ref", file: "a.txt", line: 2, detail: "here" }],
  summary: "It is wrong.",
  fix: { assessment: "not_applicable", detail: "d", betterFix: null },
};

const summary: Summary = {
  goal: { text: "Add b.", source: "stated" },
  changes: ["Adds b."],
  achieved: { verdict: "yes", gaps: [], extras: [] },
  lookAt: [],
};

function stubAgent(answer = "It is on `a.txt:2`."): {
  runAgent: RunAgent;
  tasks: AgentTask<unknown>[];
} {
  const tasks: AgentTask<unknown>[] = [];
  const runAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    tasks.push(task as AgentTask<unknown>);
    const output =
      task.role === "reviewer"
        ? review
        : task.role === "summarizer"
          ? summary
          : task.role === "verifier"
            ? verdict
            : { answer };
    return {
      status: "ok",
      output: task.schema.parse(output),
      rawText: "",
      raw: {},
      error: null,
      costUsd: 0.04,
      usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
      durationMs: 10,
    };
  };
  return { runAgent, tasks };
}

async function reviewRun(runAgent: RunAgent) {
  return runReview({
    cwd: repo,
    base: "main",
    harness: "claude",
    models: DEFAULT_MODELS.claude,
    trust: OWN_CHECKOUT,
    runAgent,
    log: () => {},
  });
}

const session = async (root: string, runAgent: RunAgent) => {
  const ask = await loadAskRun(root);
  return createAskSession({
    ask,
    checkout: await openCheckout(repo, ask),
    harness: "claude",
    model: DEFAULT_MODELS.claude.verifier,
    runAgent,
    log: () => {},
    onActivity: () => {},
    verbose: false,
  });
};

describe("ask", () => {
  it("answers with the run's context, records the call, and keeps review totals as they were", async () => {
    const { runAgent, tasks } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    const before = await readFile(runDir.runJsonPath, "utf8");

    const asking = await session(runDir.root, runAgent);
    expect(describeFindings(asking.findings)).toBe("1 finding: 1 confirmed");
    const first = await asking.ask("Why b?");
    const second = await asking.ask("And then?");

    expect(first).toMatchObject({
      answer: "It is on `a.txt:2`.",
      costUsd: 0.04,
      findingsChanged: null,
    });
    expect(second.answer).not.toBeNull();
    const [one, two] = tasks.filter((t) => t.role === "answerer");
    expect(one).toMatchObject({ cwd: repo, model: "claude-sonnet-5-5", effort: "high" });
    expect(one!.sharedContext).toContain("+b");
    expect(one!.prompt).toContain("Why b?");
    expect(one!.prompt).toContain("F-001 [confirmed, medium] a.txt:2: Off by one");
    expect(one!.prompt).toContain("Add b.");
    expect(one!.prompt).toContain("change"); // the commit message
    expect(one!.prompt).toContain("This is the first question.");
    expect(two!.prompt).toContain("**Question:** Why b?");
    expect(two!.sharedContext).toBe(one!.sharedContext);

    const asks = (await readFile(runDir.asksPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(asks).toEqual([
      expect.objectContaining({
        question: "Why b?",
        answer: "It is on `a.txt:2`.",
        findings: "done",
      }),
      expect.objectContaining({ question: "And then?" }),
    ]);
    const calls = (await readFile(runDir.callsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(calls.filter((c) => c.step === "ask")).toHaveLength(2);
    expect(await readFile(runDir.runJsonPath, "utf8")).toBe(before);
  });

  it("works on a running run: findings pending, then the counts once they land", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8")) as RunRecord;
    const findings = await readFile(runDir.findingsPath, "utf8");
    const verdicts = await readFile(runDir.verdictsPath, "utf8");
    await writeJson(runDir.runJsonPath, { ...run, status: "running", pid: process.pid });
    await rm(runDir.findingsPath);
    await rm(runDir.verdictsPath);

    const asking = await session(runDir.root, runAgent);
    expect(asking.findings).toEqual({ state: "pending" });
    await writeFile(runDir.findingsPath, findings);
    expect(await asking.ask("q1")).toMatchObject({
      findingsChanged: { state: "verifying", findings: 1 },
    });
    await writeFile(runDir.verdictsPath, verdicts);
    expect((await asking.ask("q2")).findingsChanged).toMatchObject({ state: "done" });
  });

  it("treats a running run whose process is gone as failed", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8")) as RunRecord;
    await writeJson(runDir.runJsonPath, { ...run, status: "running", pid: 99999999 });
    await rm(runDir.verdictsPath);

    expect(isRunning((await loadAskRun(runDir.root)).run)).toBe(false);
    expect((await readFindings(runDir)).state).toEqual({
      state: "failed",
      error: "the review was stopped",
    });
  });

  it("returns the summary, or null when the run skipped it", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    expect(await waitForSummary(await loadAskRun(runDir.root))).toEqual({ status: "ok", summary });

    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8")) as RunRecord;
    await writeJson(runDir.runJsonPath, { ...run, summarize: false });
    await rm(runDir.summaryPath);
    expect(await waitForSummary(await loadAskRun(runDir.root))).toBeNull();
    expect((await listReviewRuns(repo)).map((r) => r.id)).toEqual([path.basename(runDir.root)]);
  });

  it("reports drift in the developer's checkout", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    const ask = await loadAskRun(runDir.root);
    expect((await openCheckout(repo, ask)).drift).toBeNull();

    await writeFile(path.join(repo, "a.txt"), "a\nc\n");
    expect((await openCheckout(repo, ask)).drift).toMatch(/uncommitted changes differ/);
  });

  it("re-adds a missing worktree at the reviewed commit, and removes it on release", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8")) as RunRecord;
    const gone = path.join(worktreesDir(repo), "123-gone");
    await writeJson(runDir.runJsonPath, { ...run, checkout: gone });

    const checkout = await openCheckout(repo, await loadAskRun(runDir.root));
    expect(checkout.worktree).toBe(true);
    expect(checkout.dir).toBe(path.join(worktreesDir(repo), `ask-${path.basename(runDir.root)}`));
    expect(await readFile(path.join(checkout.dir, "a.txt"), "utf8")).toBe("a\nb\n");

    await checkout.release();
    await expect(stat(checkout.dir)).rejects.toThrow();
  });

  it("fails when the reviewed commit is gone", async () => {
    const { runAgent } = stubAgent();
    const { runDir } = await reviewRun(runAgent);
    const run = JSON.parse(await readFile(runDir.runJsonPath, "utf8")) as RunRecord;
    await writeJson(runDir.runJsonPath, {
      ...run,
      checkout: path.join(worktreesDir(repo), "123-gone"),
      head: { sha: "0".repeat(40) },
    });
    await expect(openCheckout(repo, await loadAskRun(runDir.root))).rejects.toThrow(
      /no longer in the repo/,
    );
  });
});

describe("describeHistory", () => {
  it("keeps the newest exchanges that fit", () => {
    const long = "x".repeat(MAX_HISTORY_CHARS / 2);
    const text = describeHistory([
      { question: "old", answer: long },
      { question: "mid", answer: long },
      { question: "new", answer: "short" },
    ]);
    expect(text).toContain("(1 earlier exchange left out.)");
    expect(text).not.toContain("old");
    expect(text.indexOf("mid")).toBeLessThan(text.indexOf("new"));
  });
});
