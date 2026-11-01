import type { IndexEntry, LoadedRun, NormalizedFinding, Verdict } from "@review-flow/core";
import { describe, expect, it } from "vitest";
import { formatCompare, formatRuns } from "./runs.ts";

const plain = { color: false };

function entry(overrides: Partial<IndexEntry>): IndexEntry {
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
