import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunDir, ensureGitignored, formatRunTimestamp } from "./run-dir.ts";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "review-flow-test-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("ensureGitignored", () => {
  it("creates .gitignore when missing", async () => {
    expect(await ensureGitignored(repo)).toBe(true);
    expect(await readFile(path.join(repo, ".gitignore"), "utf8")).toBe(".review-flow/\n");
  });

  it("appends on a new line when the file lacks a trailing newline", async () => {
    await writeFile(path.join(repo, ".gitignore"), "node_modules/");
    expect(await ensureGitignored(repo)).toBe(true);
    expect(await readFile(path.join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.review-flow/\n",
    );
  });

  it.each([".review-flow", ".review-flow/", "/.review-flow/", "  /.review-flow  "])(
    "leaves the file alone when %j is already present",
    async (entry) => {
      const content = `dist/\n${entry}\n`;
      await writeFile(path.join(repo, ".gitignore"), content);
      expect(await ensureGitignored(repo)).toBe(false);
      expect(await readFile(path.join(repo, ".gitignore"), "utf8")).toBe(content);
    },
  );
});

describe("createRunDir", () => {
  it("formats the timestamp as yyyymmdd-hhmmss", () => {
    expect(formatRunTimestamp(new Date(2026, 0, 5, 7, 8, 9))).toBe("20260105-070809");
  });

  it("creates the run dir with prompts/ and raw/", async () => {
    const runDir = await createRunDir(repo, "abc1234", new Date(2026, 9, 28, 12, 30, 0));
    expect(runDir.root).toBe(path.join(repo, ".review-flow", "runs", "20261028-123000-abc1234"));
    expect((await stat(path.join(runDir.root, "prompts"))).isDirectory()).toBe(true);
    expect((await stat(path.join(runDir.root, "raw"))).isDirectory()).toBe(true);
    expect(runDir.promptPath("F-001")).toBe(path.join(runDir.root, "prompts", "F-001.md"));
  });

  it("refuses to reuse an existing run dir", async () => {
    const now = new Date(2026, 9, 28, 12, 30, 0);
    await createRunDir(repo, "abc1234", now);
    await expect(createRunDir(repo, "abc1234", now)).rejects.toThrow();
  });
});
