import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { addWorktree, removeWorktree } from "./git.ts";
import { STATE_DIR } from "./run-dir.ts";

export interface ReviewWorktree {
  dir: string;
  remove(): Promise<void>;
  /** For exit handlers, where async work doesn't run. */
  removeSync(): void;
}

function worktreesDir(repo: string): string {
  return path.join(repo, STATE_DIR, "worktrees");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes worktrees left by runs whose process is gone (a crash or a kill). */
async function removeStale(repo: string): Promise<void> {
  const dir = worktreesDir(repo);
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    const pid = Number(name.split("-")[0]);
    if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) continue;
    await removeWorktree(repo, path.join(dir, name));
  }
}

/**
 * A detached worktree at `sha` under `.review-flow/worktrees/<pid>-<sha>`, so agents read the
 * reviewed code without touching the developer's checkout. `.review-flow/` must exist.
 */
export async function createReviewWorktree(repo: string, sha: string): Promise<ReviewWorktree> {
  await removeStale(repo);
  await mkdir(worktreesDir(repo), { recursive: true });
  const dir = path.join(worktreesDir(repo), `${process.pid}-${sha.slice(0, 12)}`);
  await rm(dir, { recursive: true, force: true });
  await addWorktree(repo, dir, sha);
  return {
    dir,
    remove: () => removeWorktree(repo, dir),
    removeSync: () => {
      try {
        execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "ignore" });
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
