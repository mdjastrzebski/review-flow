import {
  summarizeCases,
  type CaseResult,
  type EvalIndexEntry,
  type LoadedEval,
  type LoadedRun,
  type NormalizedFinding,
  type ReviewIndexEntry,
  type Verdict,
} from "@review-flow/core";
import { describe, expect, it } from "vitest";
import { formatCompare, formatEval, formatEvalCompare, formatRuns } from "./runs.ts";

const plain = { color: false };

function entry(overrides: Partial<ReviewIndexEntry>): ReviewIndexEntry {
  return {
    id: "20261101-100000-abc1234",
    kind: "review",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 62_000,
    status: "ok",
    harness: "claude",
    models: {
      reviewer: { model: "claude-sonnet-5-5", effort: "high" },
      verifier: { model: "claude-sonnet-5-5", effort: "high" },
    },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    diff: { files: 2, additions: 10, deletions: 3 },
    findings: 3,
    verdicts: { confirmed: 2, inconclusive: 1, refuted: 0 },
    costUsd: 0.65,
    unknownCostCalls: 0,
    ...overrides,
  };
}

describe("formatRuns", () => {
  it("lists runs newest first, marking partial costs and failed runs", () => {
    const text = formatRuns(
      [
        entry({}),
        entry({
          id: "20261101-110000-def5678",
          status: "failed",
          harness: "cursor",
          models: {
            reviewer: { model: "grok-4.7-low", effort: null },
            verifier: { model: "composer-2.5", effort: null },
          },
          findings: null,
          verdicts: null,
          costUsd: 0.2,
          unknownCostCalls: 1,
        }),
      ],
      plain,
    );
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Run\s+Status\s+Harness\s+Models\s+Diff\s+Findings\s+Cost\s+Time$/);
    expect(lines[1]).toMatch(
      /^20261101-110000-def5678\s+failed\s+cursor\s+grok-4.7-low \/ composer-2.5\s+2 files \+10 -3\s+-\s+≥\$0.20\s+1m 2s$/,
    );
    expect(lines[2]).toMatch(
      /claude-sonnet-5-5 high\s+2 files \+10 -3\s+3 \(2 confirmed\)\s+\$0.65/,
    );
  });

  it("shows an eval's case count and scores in place of diff and findings", () => {
    const scores = summarizeCases([
      caseResult("a", "bug", "found"),
      caseResult("b", "bug", "missed"),
      caseResult("c", "clean", 1),
    ]);
    const evalEntry: EvalIndexEntry = {
      ...entry({}),
      id: "20261101-120000-eval",
      kind: "eval",
      smoke: true,
      cases: 3,
      scores,
    };
    expect(formatRuns([evalEntry], plain).split("\n")[1]).toMatch(
      /^20261101-120000-eval\s+ok\s+claude\s+claude-sonnet-5-5 high\s+eval: 3 smoke cases\s+recall 1\/2, 1.00 per clean\s+\$0.65/,
    );
  });

  it("says when there are no runs", () => {
    expect(formatRuns([], plain)).toBe("No runs yet.");
  });
});

function finding(id: string, line: number, title: string): NormalizedFinding {
  return {
    id,
    localId: id,
    title,
    file: "src/a.ts",
    lineStart: line,
    lineEnd: line,
    category: "correctness",
    severity: "low",
    claim: "c",
    rationale: "r",
    suggestedFix: null,
  };
}

function verdict(kind: Verdict["verdict"], severity: Verdict["severity"]): Verdict {
  return {
    verdict: kind,
    severity,
    confidence: "high",
    fixCost: "small",
    evidence: [],
    summary: "s",
    fix: { assessment: "not_applicable", detail: "d", betterFix: null },
  };
}

function timed(costUsd: number | null, durationMs: number, calls = 1) {
  return {
    calls,
    costUsd,
    unknownCostCalls: 0,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    durationMs,
  };
}

function loaded(
  id: string,
  model: string,
  steps: { review: number; verify: number },
  findings: NormalizedFinding[],
  verdicts: Record<string, Verdict>,
): LoadedRun {
  return {
    kind: "review",
    id,
    run: {
      harness: "claude",
      models: {
        reviewer: { model, effort: "high" },
        verifier: { model, effort: "high" },
      },
      base: { ref: "main", sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
      startedAt: "",
      finishedAt: "",
      status: "ok",
      error: null,
      steps: {
        collect: timed(null, 100, 0),
        review: timed(steps.review, 60_000),
        verify: timed(steps.verify, 30_000),
      },
      totals: timed(steps.review + steps.verify, 90_100, 2),
    },
    findings,
    verdicts,
  };
}

describe("formatCompare", () => {
  const a = loaded(
    "run-a",
    "claude-opus-5-5",
    { review: 0.74, verify: 0.48 },
    [finding("F-001", 10, "Shared bug"), finding("F-002", 40, "Only A")],
    { "F-001": verdict("confirmed", "high"), "F-002": verdict("refuted", "low") },
  );
  const b = loaded(
    "run-b",
    "claude-sonnet-5-5",
    { review: 0.34, verify: 0.31 },
    [finding("F-001", 90, "Only B"), finding("F-002", 11, "Shared bug, reworded")],
    { "F-001": verdict("inconclusive", "medium"), "F-002": verdict("confirmed", "medium") },
  );

  it("shows per-step cost and time with deltas", () => {
    const text = formatCompare(a, b, plain);
    expect(text).toMatch(/Reviewer\s+claude-opus-5-5 high\s+claude-sonnet-5-5 high/);
    expect(text).toMatch(/Diff\s+main aaaaaaa\.\.bbbbbbb/);
    expect(text).toMatch(/collect\s+-\s+-\s+-\s+0s\s+0s\s+0s\s+0 \/ 0/);
    expect(text).toMatch(/review\s+\$0.74\s+\$0.34\s+-\$0.40\s+1m 0s\s+1m 0s\s+0s\s+1 \/ 1/);
    expect(text).toMatch(/total\s+\$1.22\s+\$0.65\s+-\$0.57\s+1m 30s\s+1m 30s\s+0s\s+2 \/ 2/);
  });

  it("lists findings in both runs and in only one", () => {
    const text = formatCompare(a, b, plain);
    expect(text).toContain("Findings: 2 in A, 2 in B, 1 in both");
    expect(text).toMatch(
      /In both \(A → B\)\n {2}F-001 confirmed high\s+→\s+F-002 confirmed medium\s+src\/a.ts:10\s+Shared bug\n/,
    );
    expect(text).toMatch(/Only in A\n {2}F-002 refuted low\s+src\/a.ts:40\s+Only A/);
    expect(text).toMatch(/Only in B\n {2}F-001 inconclusive medium\s+src\/a.ts:90\s+Only B/);
    expect(text).not.toContain("different commits");
  });

  it("warns when the runs reviewed different commits, and skips findings of a failed run", () => {
    const moved = { ...b, run: { ...b.run, head: { sha: "c".repeat(40) } } };
    expect(formatCompare(a, moved, plain)).toContain("different commits");
    expect(formatCompare(a, { ...b, findings: null }, plain)).toContain("Findings: not compared");
  });
});

/** A finished case: a bug case found, refuted, or missed; or a clean case with N findings. */
function caseResult(
  id: string,
  kind: "bug" | "clean",
  outcome: "found" | "refuted" | "missed" | "failed" | number,
  costUsd = 0.5,
): CaseResult {
  const failed = outcome === "failed";
  return {
    id,
    kind,
    smoke: false,
    status: failed ? "failed" : "ok",
    error: failed ? "Reviewer failed (timeout): no output" : null,
    findings: failed ? null : typeof outcome === "number" ? outcome : 1,
    reported: failed ? null : typeof outcome === "number" ? outcome : outcome === "found" ? 1 : 0,
    bugs: failed
      ? null
      : kind === "clean"
        ? []
        : [
            {
              description: "d",
              found: outcome === "found",
              foundByReviewer: outcome !== "missed",
              findingIds: outcome === "missed" ? [] : ["F-001"],
            },
          ],
    costUsd,
    unknownCostCalls: 0,
    durationMs: 60_000,
  };
}

function loadedEval(id: string, cases: CaseResult[], smoke = false): LoadedEval {
  const scores = summarizeCases(cases);
  const totals = timed(scores.costUsd, scores.durationMs, cases.length * 2);
  return {
    kind: "eval",
    id,
    run: {
      kind: "eval",
      harness: "claude",
      models: {
        reviewer: { model: "claude-sonnet-5-5", effort: "high" },
        verifier: { model: "claude-sonnet-5-5", effort: "high" },
      },
      dataset: { dir: "eval/cases", smoke, cases: cases.map((c) => c.id) },
      startedAt: "",
      finishedAt: "",
      status: "ok",
      error: null,
      steps: { review: totals },
      totals,
      scores,
    },
    cases,
  };
}

describe("formatEval", () => {
  it("lists each case's result, failures, and the scores", () => {
    const cases = [
      caseResult("a-1", "bug", "found"),
      caseResult("b-2", "bug", "refuted"),
      caseResult("c-3", "bug", "failed", 0.1),
      caseResult("d-4", "clean", 2),
    ];
    const text = formatEval(
      { root: "/r/.review-flow/runs/x-eval", cases, scores: summarizeCases(cases) },
      plain,
    );
    expect(text).toMatch(/a-1\s+bug\s+found\s+\$0.50\s+1m 0s/);
    expect(text).toMatch(/b-2\s+bug\s+refuted/);
    expect(text).toMatch(/d-4\s+clean\s+2 findings/);
    expect(text).toContain("c-3: Reviewer failed (timeout): no output");
    expect(text).toMatch(/Recall\s+1\/2 \(50%\)/);
    expect(text).toMatch(/Reviewer recall\s+2\/2 \(100%\)/);
    expect(text).toMatch(/Findings per clean case\s+2.00 \(2 in 1\)/);
    expect(text).toMatch(/Failed cases\s+1\/4/);
    expect(text).toMatch(/Cost per case\s+\$0.40/);
    expect(text).toContain("Eval run: /r/.review-flow/runs/x-eval");
  });
});

describe("formatEvalCompare", () => {
  const a = loadedEval("eval-a", [
    caseResult("a-1", "bug", "found"),
    caseResult("b-2", "bug", "missed"),
    caseResult("d-4", "clean", 2),
  ]);
  const b = loadedEval("eval-b", [
    caseResult("a-1", "bug", "found", 0.3),
    caseResult("b-2", "bug", "found", 0.3),
    caseResult("d-4", "clean", 0, 0.3),
  ]);

  it("shows scores and per-step totals with deltas", () => {
    const text = formatEvalCompare(a, b, plain);
    expect(text).toMatch(/Cases\s+3\s+3/);
    expect(text).toMatch(/Recall\s+1\/2 \(50%\)\s+2\/2 \(100%\)\s+\+50 pts/);
    expect(text).toMatch(/Findings per clean case\s+2.00 \(2 in 1\)\s+0.00 \(0 in 1\)\s+-2.00/);
    expect(text).toMatch(/Cost per case\s+\$0.50\s+\$0.30\s+-\$0.20/);
    expect(text).toMatch(/total\s+\$1.50\s+\$0.90\s+-\$0.60/);
  });

  it("lists the cases whose outcome changed", () => {
    const text = formatEvalCompare(a, b, plain);
    expect(text).toContain("Cases: 2 of 3 shared cases changed");
    expect(text).toMatch(/b-2\s+bug\s+missed\s+→\s+found/);
    expect(text).toMatch(/d-4\s+clean\s+2 findings\s+→\s+0 findings/);
    expect(text).not.toMatch(/a-1\s+bug/);
    expect(text).not.toContain("different cases");
  });

  it("warns when the evals ran different cases", () => {
    const smoke = loadedEval("eval-s", [caseResult("a-1", "bug", "found")], true);
    const text = formatEvalCompare(a, smoke, plain);
    expect(text).toMatch(/Cases\s+3\s+1 \(smoke\)/);
    expect(text).toContain("The evals ran different cases");
    expect(text).toContain("Only in A: b-2, d-4");
    expect(text).toContain("Cases: 0 of 1 shared cases changed");
  });
});
