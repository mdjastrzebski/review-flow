import type { PullRequest } from "./github.ts";
import type { Harness } from "./models.ts";
import type { DiffStats, IndexEntry } from "./run-index.ts";

export const TRUST_LEVELS = ["own", "collaborator", "external"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** A target's trust level, as recorded in run.json. */
export interface Trust {
  level: TrustLevel;
  /** Why: the detected kind of target, plus `--trust` when the flag set the level. */
  reason: string;
}

/** The developer's own checkout. */
export const OWN_CHECKOUT: Trust = { level: "own", reason: "current checkout" };

/** Fork PRs are external; same-repo PRs come from someone with push access. */
export function prTrust(pr: Pick<PullRequest, "isCrossRepository">): Trust {
  return pr.isCrossRepository
    ? { level: "external", reason: "fork PR" }
    : { level: "collaborator", reason: "same-repo PR" };
}

/** `--trust` replaces the detected level; the reason keeps what was detected. */
export function overrideTrust(detected: Trust, flag: TrustLevel | undefined): Trust {
  if (flag === undefined || flag === detected.level) return detected;
  return { level: flag, reason: `${detected.reason}, detected ${detected.level}; set by --trust` };
}

/**
 * How a harness keeps agents read-only: `enforced` when the CLI blocks writes and shell,
 * `best-effort` when the agent is only asked to.
 */
export type Enforcement = "enforced" | "best-effort";

export const HARNESS_ENFORCEMENT: Record<Harness, Enforcement> = {
  // Tool allowlist plus the guard hook.
  claude: "enforced",
  // Ask mode with the sandbox on.
  cursor: "enforced",
};

/**
 * The trust policy for a harness: a warning to show, or null. Throws when a `best-effort` harness
 * would review an `external` target without `allowUnenforced`.
 */
export function checkHarnessTrust(
  harness: string,
  enforcement: Enforcement,
  trust: Trust,
  allowUnenforced: boolean,
): string | null {
  if (enforcement === "enforced" || trust.level === "own") return null;
  const risk = `The ${harness} harness only asks agents to stay read-only, and this ${trust.level} target can carry prompt injection.`;
  if (trust.level === "collaborator" || allowUnenforced) return risk;
  throw new Error(`${risk} Pass --allow-unenforced to review it anyway, or use another harness.`);
}

/** Cost range of past runs, the basis of the pre-flight estimate. */
export interface CostEstimate {
  minUsd: number;
  maxUsd: number;
  /** How many past runs it is based on. */
  runs: number;
}

const ESTIMATE_RUNS = 5;

/**
 * The cost range of the completed past review runs with the same harness and steps whose diff
 * size is closest to this one. null when there are none with a full cost.
 */
export function estimateCost(
  entries: readonly IndexEntry[],
  harness: Harness,
  diff: DiffStats,
  find: boolean,
): CostEstimate | null {
  const lines = (stats: DiffStats) => stats.additions + stats.deletions;
  const costs = entries
    .flatMap((e) =>
      e.kind === "review" &&
      e.status === "ok" &&
      e.harness === harness &&
      (e.findings !== null) === find &&
      e.costUsd !== null &&
      e.unknownCostCalls === 0
        ? [{ costUsd: e.costUsd, distance: Math.abs(lines(e.diff) - lines(diff)) }]
        : [],
    )
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, ESTIMATE_RUNS)
    .map((e) => e.costUsd);
  if (costs.length === 0) return null;
  return { minUsd: Math.min(...costs), maxUsd: Math.max(...costs), runs: costs.length };
}
