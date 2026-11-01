export const HARNESSES = ["claude", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

export type Role = "reviewer" | "verifier";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  /** null = don't pass a model; the harness uses its own default. */
  model: string | null;
  /** null = don't pass an effort; the harness or model uses its own default. */
  effort: Effort | null;
}

export type RoleModels = Record<Role, ModelChoice>;

// Opus 5.5 defaults to medium effort, so it is always set explicitly.
// Cursor: Composer 2.5, Cursor's own model. Grok 4.7 high timed out (20 min) as reviewer.
export const DEFAULT_MODELS: Record<Harness, RoleModels> = {
  claude: {
    reviewer: { model: "claude-opus-5-5", effort: "high" },
    verifier: { model: "claude-opus-5-5", effort: "medium" },
  },
  cursor: {
    reviewer: { model: "composer-2.5", effort: null },
    verifier: { model: "composer-2.5", effort: null },
  },
};

export interface ModelOverrides {
  /** Applies to the reviewer, and to the verifier unless `verifierModel` is set. */
  model: string | null;
  verifierModel: string | null;
}

export function resolveModels(harness: Harness, overrides: ModelOverrides): RoleModels {
  const defaults = DEFAULT_MODELS[harness];
  // Cursor model ids often carry their own effort (gpt-5.3-codex-high), and not every model
  // accepts an effort parameter, so an overridden Cursor model gets none.
  const choose = (role: Role, override: string | null): ModelChoice =>
    override === null
      ? defaults[role]
      : { model: override, effort: harness === "cursor" ? null : defaults[role].effort };
  return {
    reviewer: choose("reviewer", overrides.model),
    verifier: choose("verifier", overrides.verifierModel ?? overrides.model),
  };
}
