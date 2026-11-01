import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Harness, RoleModels } from "./models.ts";
import { STATE_DIR } from "./run-dir.ts";
import type { Verdict } from "./schemas.ts";

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export type VerdictCounts = Record<Verdict["verdict"], number>;

/** One line of `.review-flow/index.jsonl`: a run summary. Details stay in the run dir. */
export interface IndexEntry {
  /** The run dir name under `.review-flow/runs/`. */
  id: string;
  kind: "review";
  startedAt: string;
  durationMs: number;
  status: "ok" | "failed";
  harness: Harness;
  models: RoleModels;
  base: { ref: string; sha: string };
  head: { sha: string };
  diff: DiffStats;
  /** null when the run failed before the reviewer returned. */
  findings: number | null;
  /** null when the run failed before verification finished. */
  verdicts: VerdictCounts | null;
  /** null when no call has a cost. */
  costUsd: number | null;
  /** When above 0, `costUsd` is a lower bound. */
  unknownCostCalls: number;
}

/** Counts changed files and lines. Only hunk bodies count, so `---`/`+++` headers are skipped. */
export function diffStats(diff: string): DiffStats {
  const stats: DiffStats = { files: 0, additions: 0, deletions: 0 };
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      stats.files++;
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      stats.additions++;
    } else if (inHunk && line.startsWith("-")) {
      stats.deletions++;
    }
  }
  return stats;
}

export function countVerdicts(verdicts: Record<string, Verdict>): VerdictCounts {
  const counts: VerdictCounts = { confirmed: 0, inconclusive: 0, refuted: 0 };
  for (const { verdict } of Object.values(verdicts)) counts[verdict]++;
  return counts;
}

export function indexPath(repo: string): string {
  return path.join(repo, STATE_DIR, "index.jsonl");
}

export function runsPath(repo: string): string {
  return path.join(repo, STATE_DIR, "runs");
}

export async function appendIndexEntry(repo: string, entry: IndexEntry): Promise<void> {
  await appendFile(indexPath(repo), `${JSON.stringify(entry)}\n`);
}

/** Entries in the order they were written (oldest first). Unparsable lines are skipped. */
export async function readIndex(repo: string): Promise<IndexEntry[]> {
  let content: string;
  try {
    content = await readFile(indexPath(repo), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as IndexEntry];
    } catch {
      return [];
    }
  });
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds a run dir from a path, a run id, or a unique part of one (such as the short SHA).
 * Run dirs that predate the index still resolve by id.
 */
export async function resolveRun(
  repo: string,
  ref: string,
  cwd: string,
): Promise<{ id: string; root: string }> {
  const asPath = path.resolve(cwd, ref);
  if (await isDirectory(asPath)) {
    try {
      await stat(path.join(asPath, "run.json"));
      return { id: path.basename(asPath), root: asPath };
    } catch {
      // Not a run dir; try it as an id.
    }
  }

  const runs = runsPath(repo);
  const dirs = (await isDirectory(runs)) ? await readdir(runs) : [];
  const ids = [...new Set([...(await readIndex(repo)).map((e) => e.id), ...dirs])];
  const matches = ids.includes(ref) ? [ref] : ids.filter((id) => id.includes(ref));
  if (matches.length === 0) throw new Error(`No run matches "${ref}".`);
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches ${matches.length} runs: ${matches.toSorted().join(", ")}`);
  }
  const id = matches[0] as string;
  return { id, root: path.join(runs, id) };
}
