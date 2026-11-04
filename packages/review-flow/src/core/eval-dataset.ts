import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * `eval/cases/` at the repo root, from both src/core/ and dist/core/. The dataset isn't published,
 * so an installed package needs `--dataset`.
 */
export const DEFAULT_DATASET_DIR = fileURLToPath(
  new URL("../../../../eval/cases/", import.meta.url),
);

/** Clones of the case repos, outside any project so agents don't see its rules or AGENTS.md. */
export function defaultCheckoutsDir(): string {
  const cache = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
  return path.join(cache, "review-flow", "eval");
}

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Count = z.int().nonnegative();

/** Lines in the head version, inclusive. */
export const BugLocation = z.strictObject({
  file: z.string(),
  start: z.int().positive(),
  end: z.int().positive(),
});
export type BugLocation = z.infer<typeof BugLocation>;

export const EvalBug = z.strictObject({
  description: z.string(),
  fix: z.string(),
  locations: z.array(BugLocation).min(1),
});
export type EvalBug = z.infer<typeof EvalBug>;

/**
 * Nested sets, smallest first: `smoke` (a quick end-to-end check), `baseline` (what changes are
 * measured on), `full` (everything). A case's `preset` is the smallest set it belongs to.
 */
export const EVAL_PRESETS = ["smoke", "baseline", "full"] as const;

function presetIn(casePreset: EvalSubset, selected: EvalSubset): boolean {
  return EVAL_PRESETS.indexOf(casePreset) <= EVAL_PRESETS.indexOf(selected);
}

export const EvalCase = z
  .strictObject({
    id: z.string().regex(/^[\w.-]+$/),
    kind: z.enum(["bug", "clean"]),
    preset: z.enum(EVAL_PRESETS),
    title: z.string(),
    repo: z.string(),
    pr: z.string(),
    base: Sha,
    head: Sha,
    diff: z.strictObject({ files: Count, additions: Count, deletions: Count }),
    bugs: z.array(EvalBug),
  })
  .refine((c) => (c.kind === "bug") === c.bugs.length > 0, {
    message: "a bug case needs bugs, and a clean case has none",
  });
export type EvalCase = z.infer<typeof EvalCase>;

export type EvalSubset = (typeof EVAL_PRESETS)[number];

export interface DatasetSelection {
  /** Only this subset; absent or `full` selects all cases. */
  subset?: EvalSubset | undefined;
  /** Only these case ids; each must exist. Empty or absent selects all. */
  ids?: readonly string[];
}

/** Every `*.json` in `dir`, sorted by id, narrowed by `selection`. */
export async function loadDataset(
  dir: string,
  selection: DatasetSelection = {},
): Promise<EvalCase[]> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `No eval dataset at ${dir}. Pass --dataset <dir>, such as eval/cases/ in a review-flow checkout.`,
    );
  });
  const files = entries.filter((file) => file.endsWith(".json")).toSorted();
  const cases = await Promise.all(
    files.map(async (file) => {
      const parsed = EvalCase.safeParse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    }),
  );
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
    seen.add(c.id);
  }
  const ids = selection.ids ?? [];
  const unknown = ids.filter((id) => !seen.has(id));
  if (unknown.length > 0) throw new Error(`No such case in ${dir}: ${unknown.join(", ")}`);
  const selected = cases.filter(
    (c) =>
      (!selection.subset || presetIn(c.preset, selection.subset)) &&
      (ids.length === 0 || ids.includes(c.id)),
  );
  if (selected.length === 0) {
    throw new Error(`No ${selection.subset ? `${selection.subset} ` : ""}cases selected in ${dir}`);
  }
  return selected.toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Checkout dir name for a repo URL or path: its last two segments, such as `pallets__click`. */
export function checkoutName(repo: string): string {
  const segments = repo
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:\\]/)
    .filter((s) => s !== "");
  return segments
    .slice(-2)
    .join("__")
    .replaceAll(/[^\w.-]/g, "_");
}
