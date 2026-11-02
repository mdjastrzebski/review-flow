import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorktree, resolveCommit } from "./git.ts";
import { ensureStateDir } from "./run-dir.ts";
import { createReviewWorktree, leasedWorktrees, takeLease } from "./worktree.ts";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "review-flow-worktree-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "one");
  await writeFile(path.join(repo, "a.txt"), "two\n");
  git("commit", "-qam", "two");
  await ensureStateDir(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("createReviewWorktree", () => {
  it("checks out a commit without touching the checkout, and removes it", async () => {
    const first = await resolveCommit(repo, "HEAD~1");
    const worktree = await createReviewWorktree(repo, first);

    expect(await readFile(path.join(worktree.dir, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("two\n");
    expect(git("status", "--porcelain")).toBe("");

    await worktree.remove();
    expect(await exists(worktree.dir)).toBe(false);
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("removes worktrees left by dead processes", async () => {
    const sha = await resolveCommit(repo, "HEAD");
    const dir = path.join(repo, ".review-flow", "worktrees");
    await mkdir(dir, { recursive: true });
    // A pid above the usual max, so it isn't running.
    await addWorktree(repo, path.join(dir, `99999999-${sha.slice(0, 12)}`), sha);

    const worktree = await createReviewWorktree(repo, sha);
    expect(await readdir(dir)).toEqual([path.basename(worktree.dir)]);
    await worktree.remove();
  });

  it("keeps a worktree that a running ask holds, until the lease is released", async () => {
    const sha = await resolveCommit(repo, "HEAD");
    const worktree = await createReviewWorktree(repo, sha);
    const leases = path.join(repo, ".review-flow", "runs", "run-1", "leases");
    const lease = await takeLease(leases, worktree.dir);

    await worktree.remove();
    worktree.removeSync();
    expect(await exists(worktree.dir)).toBe(true);

    await lease.release();
    await worktree.remove();
    expect(await exists(worktree.dir)).toBe(false);
  });

  it("ignores and deletes leases of processes that are gone", async () => {
    const leases = path.join(repo, ".review-flow", "runs", "run-1", "leases");
    await mkdir(leases, { recursive: true });
    await writeFile(path.join(leases, "99999999"), "/some/worktree\n");

    expect(leasedWorktrees(repo)).toEqual(new Set());
    expect(await readdir(leases)).toEqual([]);
  });
});
