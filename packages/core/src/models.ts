export const HARNESSES = ["claude", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

export type Role = "reviewer" | "verifier";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  /** null = don't pass a model; the harness uses its own default. */
  model: string | null;
  /** null = harness has no effort control (Cursor). */
  effort: Effort | null;
}

export type RoleModels = Record<Role, ModelChoice>;

// Opus 5.5 defaults to medium effort, so it is always set explicitly.
// Cursor model ids churn; leave the choice to Cursor until we pin real ids.
export const DEFAULT_MODELS: Record<Harness, RoleModels> = {
  claude: {
    reviewer: { model: "claude-opus-5-5", effort: "high" },
    verifier: { model: "claude-opus-5-5", effort: "medium" },
  },
  cursor: {
    reviewer: { model: null, effort: null },
    verifier: { model: null, effort: null },
  },
};

export interface ModelOverrides {
  /** Applies to the reviewer, and to the verifier unless `verifierModel` is set. */
  model: string | null;
  verifierModel: string | null;
}

export function resolveModels(harness: Harness, overrides: ModelOverrides): RoleModels {
  const defaults = DEFAULT_MODELS[harness];
  const reviewerModel = overrides.model ?? defaults.reviewer.model;
  const verifierModel = overrides.verifierModel ?? overrides.model ?? defaults.verifier.model;
  return {
    reviewer: { ...defaults.reviewer, model: reviewerModel },
    verifier: { ...defaults.verifier, model: verifierModel },
  };
}
