import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { EvalBug } from "./eval-dataset.ts";
import { gh } from "./github.ts";

/** Keeps a large fix from dominating the judge prompt. */
export const MAX_FIX_DIFF_CHARS = 12_000;

/** Fix diffs, fetched once and kept outside any project, next to the case checkouts. */
export function defaultFixesDir(): string {
  const cache = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
  return path.join(cache, "review-flow", "eval-fixes");
}

function parsePrUrl(url: string): { repo: string; number: string } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { repo: match[1] ?? "", number: match[2] ?? "" };
}

/**
 * The diff of a bug's fix PR, from the cache or `gh pr diff`; null when it can't be had (not a
 * PR URL, no network, no `gh`), so scoring goes on with the description alone.
 */
export async function fetchFixDiff(bug: Pick<EvalBug, "fix">, dir: string): Promise<string | null> {
  const pr = parsePrUrl(bug.fix);
  if (pr === null) return null;
  const file = path.join(dir, `${pr.repo.replace("/", "__")}-${pr.number}.patch`);
  await mkdir(dir, { recursive: true });
  try {
    return await readFile(file, "utf8");
  } catch {
    // Not cached yet.
  }
  try {
    const diff = await gh(dir, ["pr", "diff", pr.number, "-R", pr.repo]);
    await writeFile(file, diff);
    return diff;
  } catch {
    return null;
  }
}

/** The fix diffs of a case's bugs, in order; null for one that couldn't be fetched. */
export async function fetchFixDiffs(
  bugs: readonly Pick<EvalBug, "fix">[],
  dir: string,
): Promise<(string | null)[]> {
  return Promise.all(bugs.map((bug) => fetchFixDiff(bug, dir)));
}
