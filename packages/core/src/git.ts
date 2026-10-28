import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

export async function shortSha(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--short", ref])).trim();
}

/** Changes on HEAD since it diverged from `base` (three-dot diff). */
export async function diffAgainstBase(repo: string, base: string): Promise<string> {
  return git(repo, ["diff", "--no-color", "--no-ext-diff", `${base}...HEAD`]);
}

export interface StatusSnapshot {
  readonly entries: readonly string[];
}

export async function snapshotStatus(repo: string): Promise<StatusSnapshot> {
  const out = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return { entries: out.split("\0").filter((entry) => entry !== "") };
}

export class WorkingTreeChangedError extends Error {
  constructor(
    readonly added: readonly string[],
    readonly removed: readonly string[],
  ) {
    const lines = [
      ...added.map((entry) => `  + ${entry}`),
      ...removed.map((entry) => `  - ${entry}`),
    ];
    super(`Working tree changed during the run:\n${lines.join("\n")}`);
    this.name = "WorkingTreeChangedError";
  }
}

/** Throws WorkingTreeChangedError if `git status` differs from the snapshot. */
export async function assertStatusUnchanged(repo: string, before: StatusSnapshot): Promise<void> {
  const after = await snapshotStatus(repo);
  const beforeSet = new Set(before.entries);
  const afterSet = new Set(after.entries);
  const added = after.entries.filter((entry) => !beforeSet.has(entry));
  const removed = before.entries.filter((entry) => !afterSet.has(entry));
  if (added.length > 0 || removed.length > 0) {
    throw new WorkingTreeChangedError(added, removed);
  }
}
