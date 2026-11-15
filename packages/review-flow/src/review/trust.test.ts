import { describe, expect, it } from "vitest";
import type { ReviewIndexEntry } from "./run-index.ts";
import {
  OWN_CHECKOUT,
  checkHarnessTrust,
  estimateCost,
  overrideTrust,
  prTrust,
  type Trust,
} from "./trust.ts";

describe("prTrust", () => {
  it("treats fork PRs as external and same-repo PRs as collaborator", () => {
    expect(prTrust({ isCrossRepository: true }).level).toBe("external");
    expect(prTrust({ isCrossRepository: false }).level).toBe("collaborator");
  });
});

describe("overrideTrust", () => {
  it("keeps the detected level without --trust or when it matches", () => {
    expect(overrideTrust(OWN_CHECKOUT, undefined)).toBe(OWN_CHECKOUT);
    expect(overrideTrust(OWN_CHECKOUT, "own")).toBe(OWN_CHECKOUT);
  });

  it("sets the level and keeps what was detected in the reason", () => {
    expect(overrideTrust({ level: "external", reason: "fork PR" }, "own")).toEqual({
      level: "own",
      reason: "fork PR, detected external; set by --trust",
    });
  });
});

describe("checkHarnessTrust", () => {
  const at = (level: Trust["level"]): Trust => ({ level, reason: "test" });

  it("allows an enforced harness for every level", () => {
    for (const level of ["own", "collaborator", "external"] as const) {
      expect(checkHarnessTrust("claude", "enforced", at(level), false)).toBeNull();
    }
  });

  it("allows best-effort for own, warns for collaborator, refuses external", () => {
    expect(checkHarnessTrust("x", "best-effort", at("own"), false)).toBeNull();
    expect(checkHarnessTrust("x", "best-effort", at("collaborator"), false)).toMatch(
      /only asks agents to stay read-only/,
    );
    expect(() => checkHarnessTrust("x", "best-effort", at("external"), false)).toThrow(
      /--allow-unenforced/,
    );
    expect(checkHarnessTrust("x", "best-effort", at("external"), true)).toMatch(/external/);
  });
});

describe("estimateCost", () => {
  const entry = (over: Partial<ReviewIndexEntry>): ReviewIndexEntry => ({
    id: "r",
    kind: "review",
    startedAt: "2026-11-01T00:00:00.000Z",
    durationMs: 1000,
    status: "ok",
    harness: "claude",
    models: {} as ReviewIndexEntry["models"],
    base: { ref: "main", sha: "a" },
    head: { sha: "b" },
    diff: { files: 1, additions: 100, deletions: 0 },
    findings: 2,
    verdicts: null,
    costUsd: 1,
    unknownCostCalls: 0,
    ...over,
  });
  const diff = { files: 1, additions: 100, deletions: 0 };

  it("is null without usable past runs", () => {
    expect(estimateCost([], "claude", diff, true)).toBeNull();
    const unusable = [
      entry({ status: "failed" }),
      entry({ harness: "cursor" }),
      entry({ findings: null }),
      entry({ costUsd: null }),
      entry({ unknownCostCalls: 1 }),
    ];
    expect(estimateCost(unusable, "claude", diff, true)).toBeNull();
  });

  it("gives the range of the 5 runs closest in size", () => {
    const entries = [
      entry({ costUsd: 9, diff: { files: 9, additions: 5000, deletions: 0 } }),
      ...[0.4, 0.6, 0.5, 0.8, 0.7].map((costUsd) => entry({ costUsd })),
    ];
    expect(estimateCost(entries, "claude", diff, true)).toEqual({
      minUsd: 0.4,
      maxUsd: 0.8,
      runs: 5,
    });
  });

  it("uses summary-only runs for a summary-only estimate", () => {
    const entries = [entry({ costUsd: 1 }), entry({ costUsd: 0.02, findings: null })];
    expect(estimateCost(entries, "claude", diff, false)).toEqual({
      minUsd: 0.02,
      maxUsd: 0.02,
      runs: 1,
    });
  });
});
