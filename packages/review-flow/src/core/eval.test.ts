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
import { ROUGH_EDGE_CHECKER_TASK_ID } from "./rough-edges.ts";
import type { FindingsOutput, ReviewOutput, RoughEdgeChecks, Verdict } from "./schemas.ts";

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

const review: FindingsOutput = {
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

  it("scores rough edges apart from findings when asked for", async () => {
    const edge = (localId: string): ReviewOutput["roughEdges"][number] => ({
      localId,
      title: `edge ${localId}`,
      file: "a.txt",
      lineStart: 1,
      lineEnd: 2,
      lens: "design",
      observation: "o",
      suggestion: "s",
    });
    const withEdges: ReviewOutput = { ...review, roughEdges: ["1", "2", "3"].map(edge) };
    const checks: RoughEdgeChecks = {
      checks: [
        { localId: "R-001", status: "accurate", note: "n" },
        { localId: "R-002", status: "unclear", note: "n" },
        { localId: "R-003", status: "inaccurate", note: "n" },
      ],
    };
    const runAgent: RunAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
      const answer =
        task.role === "reviewer"
          ? withEdges
          : task.taskId === ROUGH_EDGE_CHECKER_TASK_ID
            ? checks
            : confirmed;
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
    const result = await runEval({
      ...options([bugCase("hit", 2), evalCase("clean")], runAgent),
      roughEdges: true,
    });

    const counts = { accurate: 1, unclear: 1, inaccurate: 1, checkCostUsd: 0.25 };
    expect(result.cases.map((c) => c.roughEdges)).toEqual([counts, counts]);
    // Findings are scored as without rough edges.
    expect(result.scores).toMatchObject({ found: 1, cleanFindings: 1, costUsd: 1.5 });
    expect(result.scores.roughEdges).toEqual({
      cases: 2,
      accurate: 2,
      unclear: 2,
      inaccurate: 2,
      keptPerCase: 2,
      keptPerCleanCase: 2,
      checkCostUsd: 0.5,
      unknownCheckCost: 0,
    });
    const loaded = await loadRun(result.root);
    if (loaded.kind !== "eval") throw new Error("expected an eval run");
    expect(loaded.run.roughEdges).toBe(true);
    expect(loaded.run.steps.check).toMatchObject({ calls: 2, costUsd: 0.5 });
  });

  it("grades rough edges with the rubric judge, in the checkout, apart from the run's cost", async () => {
    const edge: ReviewOutput["roughEdges"][number] = {
      localId: "1",
      title: "edge",
      file: "a.txt",
      lineStart: 1,
      lineEnd: 2,
      lens: "design",
      observation: "o",
      suggestion: "s",
    };
    const reviewer: RunAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
      const answer =
        task.role === "reviewer"
          ? { ...review, roughEdges: [edge] }
          : task.taskId === ROUGH_EDGE_CHECKER_TASK_ID
            ? { checks: [{ localId: "R-001", status: "inaccurate", note: "n" }] }
            : confirmed;
      return {
        status: "ok",
        output: task.schema.parse(answer),
        rawText: "",
        raw: {},
        error: null,
        costUsd: 0.25,
        usage: null,
        durationMs: 10,
      };
    };
    const judged: AgentTask<unknown>[] = [];
    const judge: RunAgent = async <T>(task: AgentTask<T>): Promise<AgentResult<T>> => {
      judged.push(task as AgentTask<unknown>);
      const grade = {
        reason: "r",
        accurate: true,
        notLocal: true,
        concrete: true,
        worthPosting: true,
      };
      return {
        status: "ok",
        output: task.schema.parse({ edges: [{ id: "R-001", ...grade }] }),
        rawText: "",
        raw: {},
        error: null,
        costUsd: 0.4,
        usage: null,
        durationMs: 10,
      };
    };
    const result = await runEval({
      ...options([evalCase("clean")], reviewer),
      roughEdges: true,
      edgeJudge: {
        harness: "cursor",
        model: { model: "judge-model", effort: null },
        runAgent: judge,
      },
    });

    expect(judged).toHaveLength(1);
    expect(judged[0]?.cwd).toContain(checkouts);
    expect(result.cases[0]?.roughEdges?.judge).toMatchObject({
      status: "ok",
      kept: 0,
      dropped: 1,
      droppedPostable: 1,
    });
    expect(result.scores.roughEdges?.judge).toMatchObject({
      droppedAcceptedRate: 1,
      postableRate: 1,
      costUsd: 0.4,
    });
    // The judge's cost isn't the run's: reviewer, verifier, and checker at $0.25 each.
    expect(result.scores.costUsd).toBe(0.75);
    const saved = JSON.parse(
      await readFile(path.join(result.root, "cases", "clean", "rough-edge-judge.json"), "utf8"),
    );
    expect(saved).toEqual([
      {
        id: "R-001",
        title: "edge",
        check: "inaccurate",
        grade: expect.objectContaining({ worthPosting: true }),
      },
    ]);
    const loaded = await loadRun(result.root);
    if (loaded.kind !== "eval") throw new Error("expected an eval run");
    expect(loaded.run.edgeJudge).toEqual({
      harness: "cursor",
      model: { model: "judge-model", effort: null },
    });
  });

  it("leaves rough edges out of the results by default", async () => {
    const result = await runEval(options([evalCase("clean")]));
    expect(result.cases[0]).not.toHaveProperty("roughEdges");
    expect(result.scores).not.toHaveProperty("roughEdges");
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
