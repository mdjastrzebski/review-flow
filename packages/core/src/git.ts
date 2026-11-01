import { execFile } from "node:child_process";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    // Fail instead of waiting for credentials (clone and fetch of eval repos).
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes `dir` a clone of `url` that has all `commits`: cloned when missing (into a temp dir, so
 * an interrupted clone isn't mistaken for a finished one), fetched when a commit is missing.
 */
export async function ensureClone(
  url: string,
  dir: string,
  commits: readonly string[],
): Promise<void> {
  try {
    await stat(dir);
  } catch {
    await mkdir(path.dirname(dir), { recursive: true });
    const temp = `${dir}.partial-${process.pid}`;
    await rm(temp, { recursive: true, force: true });
    await git(path.dirname(dir), ["clone", "--quiet", "--no-checkout", url, temp]);
    await rename(temp, dir);
  }
  const root = await resolveRepoRoot(dir).catch(() => null);
  if (root !== (await realpath(dir))) throw new Error(`${dir} exists but is not a git clone.`);
  for (const sha of commits) {
    if (await hasCommit(dir, sha)) continue;
    await git(dir, ["fetch", "--quiet", "origin"]);
    if (!(await hasCommit(dir, sha))) throw new Error(`${url} has no commit ${sha}.`);
  }
}

/** Checks out `sha` detached, dropping any local changes and untracked or ignored files. */
export async function checkoutDetached(repo: string, sha: string): Promise<void> {
  await git(repo, ["checkout", "--quiet", "--force", "--detach", sha]);
  await git(repo, ["clean", "--quiet", "-ffdx"]);
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
