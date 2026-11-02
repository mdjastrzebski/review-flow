import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, AgentTask, RunAgent } from "./agent.ts";
import { loadRun } from "./compare.ts";
import { runEval, type EvalRunOptions } from "./eval.ts";
import type { EvalCase } from "./eval-dataset.ts";
import type { CaseResult } from "./eval-score.ts";
import { WorkingTreeChangedError } from "./git.ts";
import { DEFAULT_MODELS } from "./models.ts";
import { readIndex } from "./run-index.ts";
import type { ReviewOutput, Verdict } from "./schemas.ts";

let tmp: string;
let remote: string;
let results: string;
let checkouts: string;
let base: string;
let head: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initRepo(dir: string): Promise<void> {
  execFileSync("mkdir", ["-p", dir]);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "review-flow-eval-"));
  remote = path.join(tmp, "upstream", "lib");
  results = path.join(tmp, "results");
  checkouts = path.join(tmp, "checkouts");
  await initRepo(remote);
  await writeFile(path.join(remote, "a.txt"), "a\n");
  git(remote, "add", ".");
  git(remote, "commit", "-qm", "init");
  base = git(remote, "rev-parse", "HEAD");
  await writeFile(path.join(remote, "a.txt"), "a\nb\n");
  git(remote, "commit", "-qam", "change");
  head = git(remote, "rev-parse", "HEAD");
  await initRepo(results);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function evalCase(id: string, overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id,
    kind: "clean",
    preset: "full",
    title: id,
    repo: remote,
    pr: "",
    base,
    head,
    diff: { files: 1, additions: 1, deletions: 0 },
    bugs: [],
    ...overrides,
  };
}

const bugCase = (id: string, line: number) =>
  evalCase(id, {
    kind: "bug",
    bugs: [{ description: "d", fix: "f", locations: [{ file: "a.txt", start: line, end: line }] }],
  });

const review: ReviewOutput = {
  findings: [
    {
      localId: "1",
      title: "t",
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

const confirmed: Verdict = {
  verdict: "confirmed",
  severity: "medium",
  confidence: "high",
  fixCost: "trivial",
  evidence: [{ kind: "code_ref", file: "a.txt", line: 2, detail: "here" }],
  summary: "s",
  fix: { assessment: "not_applicable", detail: "d", betterFix: null },
};

function stubAgent(effect: (task: AgentTask<unknown>) => Promise<void> = async () => {}): RunAgent {
  return async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
    await effect(task as AgentTask<unknown>);
    const answer = task.role === "reviewer" ? review : confirmed;
    return {
      status: "ok",
      output: task.schema.parse(answer),
      rawText: "",
      raw: {},
      error: null,
      costUsd: 0.25,
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
      durationMs: 10,
    };
  };
}

function options(cases: EvalCase[], runAgent = stubAgent()): EvalRunOptions {
  return {
    cwd: results,
    cases,
    dataset: "eval/cases",
    // Summaries are covered by the pipeline tests; here they would only add calls.
    summarize: false,
    checkoutsDir: checkouts,
    harness: "claude",
    models: DEFAULT_MODELS.claude,
    runAgent,
    log: () => {},
  };
}

describe("runEval", () => {
  it("reviews each case in its own checkout and saves a scored eval run", async () => {
    const cases = [
      bugCase("hit", 2),
      bugCase("miss", 40),
      evalCase("clean"),
      evalCase("gone", { head: "f".repeat(40) }),
    ];
    const result = await runEval(options(cases));

    expect(result.cases.map((c) => [c.id, c.status, c.bugs?.map((b) => b.found) ?? null])).toEqual([
      ["hit", "ok", [true]],
      ["miss", "ok", [false]],
      ["clean", "ok", []],
      ["gone", "failed", null],
    ]);
    expect(result.cases[3]?.error).toContain(`has no commit ${"f".repeat(40)}`);
    expect(result.scores).toMatchObject({
      cases: 4,
      failed: 1,
      bugs: 2,
      found: 1,
      recall: 0.5,
      cleanCases: 1,
      cleanFindings: 1,
      costUsd: 1.5,
    });

    // One clone, at the case head, untouched: run dirs live in the eval run, not the checkout.
    const checkout = path.join(checkouts, "upstream__lib");
    expect(await readdir(checkouts)).toEqual(["upstream__lib"]);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(git(checkout, "status", "--porcelain", "--ignored")).toBe("");

    const caseDirs = await readdir(path.join(result.root, "cases"));
    expect(caseDirs.toSorted()).toEqual(["clean", "hit", "miss"]);
    await stat(path.join(result.root, "cases", "hit", "report.md"));

    const saved = JSON.parse(await readFile(path.join(result.root, "cases.json"), "utf8"));
    expect(saved).toEqual(result.cases);

    const loaded = await loadRun(result.root);
    if (loaded.kind !== "eval") throw new Error("expected an eval run");
    expect(loaded.cases).toEqual(result.cases);
    expect(loaded.run).toMatchObject({
      status: "ok",
      dataset: { dir: "eval/cases", subset: null, cases: ["hit", "miss", "clean", "gone"] },
      scores: result.scores,
    });
    expect(Object.keys(loaded.run.steps)).toEqual(["collect", "review", "verify", "report"]);
    expect(loaded.run.steps.review).toMatchObject({ calls: 3, costUsd: 0.75 });
    expect(loaded.run.steps.verify).toMatchObject({ calls: 3, costUsd: 0.75 });
    expect(loaded.run.totals).toMatchObject({ calls: 6, costUsd: 1.5, unknownCostCalls: 0 });

    expect(await readIndex(results)).toEqual([
      expect.objectContaining({
        id: path.basename(result.root),
        kind: "eval",
        status: "ok",
        cases: 4,
        scores: result.scores,
        costUsd: 1.5,
      }),
    ]);
  });

  it("reuses the clone on the next eval", async () => {
    await runEval(options([bugCase("hit", 2)]));
    // A new upstream commit is fetched when a case needs it.
    await writeFile(path.join(remote, "a.txt"), "a\nb\nc\n");
    git(remote, "commit", "-qam", "more");
    const next = git(remote, "rev-parse", "HEAD");
    // Not the same second as the first eval's run dir.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await runEval(
      options([bugCase("hit", 2), evalCase("next", { base: head, head: next })]),
    );
    expect(result.cases.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(git(path.join(checkouts, "upstream__lib"), "rev-parse", "HEAD")).toBe(next);
  });

  it("stops when an agent changes the checkout, keeping the cases it finished", async () => {
    const runAgent = stubAgent();
    // Calls 1 and 2 review and verify the first case; call 3 is the second case's reviewer.
    let calls = 0;
    const writing: RunAgent = async (task) => {
      calls++;
      if (calls === 3) await writeFile(path.join(task.cwd, "stray.txt"), "x");
      return runAgent(task);
    };
    const error = await runEval(
      options([bugCase("first", 2), bugCase("second", 2)], writing),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkingTreeChangedError);

    const [entry] = await readIndex(results);
    expect(entry).toMatchObject({ kind: "eval", status: "failed" });
    const root = path.join(results, ".review-flow", "runs", entry?.id ?? "");
    const cases = JSON.parse(await readFile(path.join(root, "cases.json"), "utf8")) as CaseResult[];
    expect(cases.map((c) => c.id)).toEqual(["first"]);
    const loaded = await loadRun(root);
    expect(loaded.run).toMatchObject({ status: "failed", scores: { cases: 1, found: 1 } });
  });
});
