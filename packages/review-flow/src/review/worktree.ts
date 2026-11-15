import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { addWorktree, removeWorktree } from "./git.ts";
import { STATE_DIR } from "./run-dir.ts";
import { runsPath } from "./run-index.ts";

export interface ReviewWorktree {
  dir: string;
  /** Removes the worktree, unless a running `ask` holds a lease on it. */
  remove(): Promise<void>;
  /** For exit handlers, where async work doesn't run. */
  removeSync(): void;
}

export function worktreesDir(repo: string): string {
  return path.join(repo, STATE_DIR, "worktrees");
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Worktrees held by a running `ask`: each lease is `runs/<id>/leases/<pid>`, holding the
 * worktree's path. Leases of processes that are gone are deleted. Sync, for exit handlers.
 */
export function leasedWorktrees(repo: string): Set<string> {
  const held = new Set<string>();
  const list = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const run of list(runsPath(repo))) {
    const leases = path.join(runsPath(repo), run, "leases");
    for (const name of list(leases)) {
      const file = path.join(leases, name);
      if (!isAlive(Number(name))) {
        rmSync(file, { force: true });
        continue;
      }
      try {
        held.add(readFileSync(file, "utf8").trim());
      } catch {
        // Released while we looked.
      }
    }
  }
  return held;
}

/** Removes worktrees left by runs whose process is gone (a crash or a kill), unless leased. */
async function removeStale(repo: string): Promise<void> {
  const dir = worktreesDir(repo);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const leased = leasedWorktrees(repo);
  for (const name of entries) {
    const pid = Number(name.split("-")[0]);
    if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) continue;
    if (leased.has(path.join(dir, name))) continue;
    await removeWorktree(repo, path.join(dir, name));
  }
}

/**
 * A detached worktree at `sha` under `.review-flow/worktrees/<name>` (default `<pid>-<sha>`), so
 * agents read the reviewed code without touching the developer's checkout. `.review-flow/` must
 * exist.
 */
export async function createReviewWorktree(
  repo: string,
  sha: string,
  name = `${process.pid}-${sha.slice(0, 12)}`,
): Promise<ReviewWorktree> {
  await removeStale(repo);
  await mkdir(worktreesDir(repo), { recursive: true });
  const dir = path.join(worktreesDir(repo), name);
  await rm(dir, { recursive: true, force: true });
  await addWorktree(repo, dir, sha);
  return reviewWorktree(repo, dir);
}

/** Handle to an existing worktree under `.review-flow/worktrees/`. */
export function reviewWorktree(repo: string, dir: string): ReviewWorktree {
  return {
    dir,
    remove: async () => {
      if (!leasedWorktrees(repo).has(dir)) await removeWorktree(repo, dir);
    },
    removeSync: () => {
      if (leasedWorktrees(repo).has(dir)) return;
      try {
        execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "ignore" });
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface Lease {
  /** Drops the lease. Removing the worktree, if no one else needs it, is the caller's call. */
  release(): Promise<void>;
  releaseSync(): void;
}

/** Holds `checkout` for this process until released, so the review leaves it in place. */
export async function takeLease(leasesDir: string, checkout: string): Promise<Lease> {
  await mkdir(leasesDir, { recursive: true });
  const file = path.join(leasesDir, String(process.pid));
  await writeFile(file, `${checkout}\n`);
  return {
    release: () => rm(file, { force: true }),
    releaseSync: () => rmSync(file, { force: true }),
  };
}
