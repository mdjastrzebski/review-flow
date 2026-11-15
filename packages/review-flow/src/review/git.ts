import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    // Fail instead of waiting for credentials (clone and fetch of eval repos).
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
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

export async function hasCommit(repo: string, sha: string): Promise<boolean> {
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

const DEFAULT_BRANCHES = ["main", "master"] as const;

export interface DefaultBase {
  ref: string;
  /** Set when origin couldn't be fetched and a possibly stale local branch is used. */
  warning: string | null;
}

/**
 * The base when none is given: the default branch freshly fetched from origin, so already-merged
 * upstream work doesn't leak into the diff. Falls back to the local branch.
 */
export async function defaultBase(cwd: string): Promise<DefaultBase> {
  const repo = await resolveRepoRoot(cwd);
  const hasOrigin = await git(repo, ["remote", "get-url", "origin"]).then(
    () => true,
    () => false,
  );
  if (hasOrigin) {
    for (const branch of DEFAULT_BRANCHES) {
      try {
        await git(repo, [
          "fetch",
          "--quiet",
          "origin",
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]);
        return { ref: `origin/${branch}`, warning: null };
      } catch {
        // Not on the remote, or the fetch failed; try the next name, then local.
      }
    }
  }
  for (const branch of DEFAULT_BRANCHES) {
    if (!(await hasCommit(repo, `refs/heads/${branch}`))) continue;
    const reason = hasOrigin ? `Couldn't fetch main or master from origin` : "No origin remote";
    return { ref: branch, warning: `${reason}; using local ${branch}, which may be stale.` };
  }
  throw new Error("No main or master branch found. Pass --base <ref>.");
}

/** Remote name → fetch URL. */
export async function remoteUrls(repo: string): Promise<Map<string, string>> {
  const remotes = new Map<string, string>();
  for (const line of (await git(repo, ["remote", "-v"])).split("\n")) {
    const [name, url, kind] = line.split(/\s+/);
    if (name && url && kind === "(fetch)") remotes.set(name, url);
  }
  return remotes;
}

/**
 * Fetches a GitHub PR's base branch into `<remote>/<baseBranch>` and its head commit. The head
 * lands only in FETCH_HEAD, so no ref is added to the repo.
 */
export async function fetchPullRequest(
  repo: string,
  remote: string,
  number: number,
  baseBranch: string,
  headSha: string,
): Promise<void> {
  await git(repo, [
    "fetch",
    "--quiet",
    remote,
    `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
    `refs/pull/${number}/head`,
  ]);
  if (!(await hasCommit(repo, headSha))) {
    throw new Error(`PR #${number} moved while it was fetched; run again.`);
  }
}

/** Adds a detached worktree at `sha`. Hooks are off, so checking out runs no repo code. */
export async function addWorktree(repo: string, dir: string, sha: string): Promise<void> {
  await git(repo, [
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "--quiet",
    "--detach",
    dir,
    sha,
  ]);
}

/** Removes a worktree and its git metadata. Never throws: cleanup must not hide the real error. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await git(repo, ["worktree", "prune"]).catch(() => {});
}

/** The tree a commit points at, to compare content regardless of commit metadata. */
export async function treeOf(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", `${ref}^{tree}`])).trim();
}

export async function shortSha(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--short", ref])).trim();
}

/** Changes on `head` since it diverged from `base` (three-dot diff). */
export async function diffAgainstBase(repo: string, base: string, head = "HEAD"): Promise<string> {
  return git(repo, ["diff", "--no-color", "--no-ext-diff", `${base}...${head}`]);
}

/** Messages of the commits on `head` that aren't on `base`, oldest first. */
export async function commitMessages(repo: string, base: string, head = "HEAD"): Promise<string[]> {
  const out = await git(repo, ["log", "--reverse", "--format=%B%x00", `${base}..${head}`]);
  return out
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
}

export interface WorkingTreeSnapshot {
  /** A commit on top of HEAD holding the working tree. Unreferenced, so git gc removes it. */
  sha: string;
  /** Files that differ from HEAD. */
  files: number;
}

/**
 * Commits the working tree (staged, unstaged, and untracked, respecting .gitignore) on top of
 * HEAD, using a temporary index so the developer's index, branch, and stash are untouched.
 * Returns null when the working tree matches HEAD. Run dirs in `.review-flow/` are left out.
 */
export async function snapshotWorkingTree(repo: string): Promise<WorkingTreeSnapshot | null> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "review-flow-index-"));
  const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
  try {
    // Start from HEAD so tracked files that match .gitignore are kept, not dropped.
    await git(repo, ["read-tree", "HEAD"], env);
    await git(repo, ["add", "-A"], env);
    // Not an exclude pathspec: git add fails on one that names an ignored path.
    await git(repo, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", ".review-flow"], env);
    const tree = (await git(repo, ["write-tree"], env)).trim();
    const changed = await git(repo, ["diff", "--name-only", "-z", "HEAD", tree]);
    const files = changed.split("\0").filter((name) => name !== "").length;
    if (files === 0) return null;
    const identity = { name: "review-flow", email: "review-flow@localhost" };
    const sha = (
      await git(
        repo,
        ["commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", "review-flow snapshot"],
        {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        },
      )
    ).trim();
    return { sha, files };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
