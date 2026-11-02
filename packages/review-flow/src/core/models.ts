export const HARNESSES = ["claude", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

export type Role = "summarizer" | "reviewer" | "verifier";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelChoice {
  /** null = don't pass a model; the harness uses its own default. */
  model: string | null;
  /** null = don't pass an effort; the harness or model uses its own default. */
  effort: Effort | null;
}

export type RoleModels = Record<Role, ModelChoice>;

// Claude: Sonnet 5.5 high matched Opus 5.5 on quality at about half the cost. Effort is set
// explicitly, since lower efforts answer from the diff without reading the repo.
// The summarizer gets less effort: it reads the diff and the stated goal and writes ~150 words.
// Cursor: Grok 4.7 low. Composer 2.5 was cheaper but missed a high-severity bug; higher Grok
// efforts were slower, costlier, and read outside the repo.
export const DEFAULT_MODELS: Record<Harness, RoleModels> = {
  claude: {
    summarizer: { model: "claude-sonnet-5-5", effort: "medium" },
    reviewer: { model: "claude-sonnet-5-5", effort: "high" },
    verifier: { model: "claude-sonnet-5-5", effort: "high" },
  },
  cursor: {
    summarizer: { model: "grok-4.7-low", effort: null },
    reviewer: { model: "grok-4.7-low", effort: null },
    verifier: { model: "grok-4.7-low", effort: null },
  },
};

export interface ModelOverrides {
  /** Applies to every role, unless the role's own override is set. */
  model: string | null;
  verifierModel: string | null;
  summarizerModel?: string | null;
  /** Applies to every role, unless the role's own override is set. */
  effort?: Effort | null;
  verifierEffort?: Effort | null;
  summarizerEffort?: Effort | null;
}

export function resolveModels(harness: Harness, overrides: ModelOverrides): RoleModels {
  const defaults = DEFAULT_MODELS[harness];
  // Cursor model ids often carry their own effort (gpt-5.3-codex-high), and not every model
  // accepts an effort parameter, so an overridden Cursor model gets none unless one is given.
  const choose = (role: Role, model: string | null, effort: Effort | null): ModelChoice => ({
    model: model ?? defaults[role].model,
    effort: effort ?? (model !== null && harness === "cursor" ? null : defaults[role].effort),
  });
  const effort = overrides.effort ?? null;
  return {
    summarizer: choose(
      "summarizer",
      overrides.summarizerModel ?? overrides.model,
      overrides.summarizerEffort ?? effort,
    ),
    reviewer: choose("reviewer", overrides.model, effort),
    verifier: choose(
      "verifier",
      overrides.verifierModel ?? overrides.model,
      overrides.verifierEffort ?? effort,
    ),
  };
}
