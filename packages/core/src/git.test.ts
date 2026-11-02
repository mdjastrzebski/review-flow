import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultBase, resolveCommit, snapshotWorkingTree } from "./git.ts";

let dir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function initRepo(name: string, branch: string): Promise<string> {
  const repo = path.join(dir, name);
  git(dir, "init", "-q", "-b", branch, name);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await commit(repo, "init");
  return repo;
}

async function commit(repo: string, message: string): Promise<void> {
  await writeFile(path.join(repo, "a.txt"), `${message}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", message);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "review-flow-git-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("defaultBase", () => {
  it("fetches origin/main, so upstream commits made after the clone are included", async () => {
    const upstream = await initRepo("upstream", "main");
    git(dir, "clone", "-q", upstream, "clone");
    const clone = path.join(dir, "clone");
    await commit(upstream, "merged upstream");

    expect(await defaultBase(clone)).toEqual({ ref: "origin/main", warning: null });
    expect(await resolveCommit(clone, "origin/main")).toBe(await resolveCommit(upstream, "HEAD"));
  });

  it("uses origin/master when origin has no main", async () => {
    const upstream = await initRepo("upstream", "master");
    git(dir, "clone", "-q", upstream, "clone");

    expect(await defaultBase(path.join(dir, "clone"))).toEqual({
      ref: "origin/master",
      warning: null,
    });
  });

  it("falls back to local main with a warning when there is no origin", async () => {
    const repo = await initRepo("repo", "main");

    const base = await defaultBase(repo);
    expect(base.ref).toBe("main");
    expect(base.warning).toMatch(/No origin remote/);
  });

  it("falls back to local main with a warning when the fetch fails", async () => {
    const repo = await initRepo("repo", "main");
    git(repo, "remote", "add", "origin", path.join(dir, "missing"));

    const base = await defaultBase(repo);
    expect(base.ref).toBe("main");
    expect(base.warning).toMatch(/Couldn't fetch/);
  });

  it("throws when there is no main or master", async () => {
    const repo = await initRepo("repo", "trunk");

    await expect(defaultBase(repo)).rejects.toThrow(/--base/);
  });
});

describe("snapshotWorkingTree", () => {
  function show(repo: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: repo }).toString();
  }

  it("is null when the working tree matches HEAD", async () => {
    const repo = await initRepo("repo", "main");

    expect(await snapshotWorkingTree(repo)).toBeNull();
  });

  it("commits staged, unstaged, and untracked changes on top of HEAD", async () => {
    const repo = await initRepo("repo", "main");
    await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(repo, "staged.txt"), "staged\n");
    git(repo, "add", ".gitignore", "staged.txt");
    await writeFile(path.join(repo, "a.txt"), "unstaged\n");
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n");
    await writeFile(path.join(repo, "ignored.txt"), "ignored\n");
    await mkdir(path.join(repo, ".review-flow"));
    await writeFile(path.join(repo, ".review-flow", "run.json"), "{}\n");
    const statusBefore = show(repo, "status", "--porcelain");

    const snapshot = await snapshotWorkingTree(repo);

    expect(snapshot?.files).toBe(4);
    const sha = snapshot?.sha ?? "";
    expect(show(repo, "rev-parse", `${sha}^`)).toBe(show(repo, "rev-parse", "HEAD"));
    expect(show(repo, "diff", "--name-only", "HEAD", sha).split("\n").filter(Boolean)).toEqual([
      ".gitignore",
      "a.txt",
      "staged.txt",
      "untracked.txt",
    ]);
    expect(show(repo, "status", "--porcelain")).toBe(statusBefore);
  });

  it("works when .review-flow is gitignored", async () => {
    const repo = await initRepo("repo", "main");
    await writeFile(path.join(repo, ".gitignore"), ".review-flow/\n");
    await mkdir(path.join(repo, ".review-flow"));
    await writeFile(path.join(repo, ".review-flow", "run.json"), "{}\n");

    const snapshot = await snapshotWorkingTree(repo);

    expect(show(repo, "diff", "--name-only", "HEAD", snapshot?.sha ?? "")).toBe(".gitignore\n");
  });

  it("keeps tracked files that match .gitignore", async () => {
    const repo = await initRepo("repo", "main");
    await writeFile(path.join(repo, ".gitignore"), "a.txt\n");

    const snapshot = await snapshotWorkingTree(repo);

    expect(show(repo, "diff", "--name-only", "HEAD", snapshot?.sha ?? "")).toBe(".gitignore\n");
  });
});
