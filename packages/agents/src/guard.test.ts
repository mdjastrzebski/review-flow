import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardToolCall } from "./guard.ts";

let sandbox: string;
let repo: string;
let outside: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "review-flow-guard-"));
  repo = path.join(sandbox, "repo");
  outside = path.join(sandbox, "outside");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(repo, "src", "index.ts"), "");
  await writeFile(path.join(outside, "secret"), "");
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function decide(toolName: string, toolInput: Record<string, unknown>, cwd = repo) {
  const reason = await guardToolCall(cwd, { tool_name: toolName, tool_input: toolInput });
  return { allowed: reason === null, reason };
}

describe("guardToolCall", () => {
  it("allows reads and searches inside the repo", async () => {
    expect((await decide("Read", { file_path: "src/index.ts" })).allowed).toBe(true);
    expect((await decide("Read", { file_path: path.join(repo, "src/new.ts") })).allowed).toBe(true);
    expect((await decide("Glob", { pattern: "src/**/*.ts" })).allowed).toBe(true);
    expect(
      (await decide("Grep", { pattern: "\\.\\./", glob: "**/*.ts", path: "src" })).allowed,
    ).toBe(true);
  });

  it("denies tools that aren't read-only", async () => {
    const { allowed, reason } = await decide("Bash", { command: "ls" });
    expect(allowed).toBe(false);
    expect(reason).toMatch(/read-only/);
  });

  it("denies paths outside the repo", async () => {
    expect((await decide("Read", { file_path: "../outside/secret" })).allowed).toBe(false);
    expect((await decide("Grep", { pattern: "x", path: outside })).allowed).toBe(false);
  });

  it.each(["/etc/*", "~/.ssh/*", "../outside/*", "src/../../**/*"])(
    "denies a Glob pattern that escapes the repo: %s",
    async (pattern) => {
      expect((await decide("Glob", { pattern })).allowed).toBe(false);
    },
  );

  it("denies a Grep glob that escapes the repo", async () => {
    expect((await decide("Grep", { pattern: "x", glob: "../**/*" })).allowed).toBe(false);
  });

  it("denies a symlink in the repo that points outside it", async () => {
    await symlink(path.join(outside, "secret"), path.join(repo, "src", "link"));
    await symlink(outside, path.join(repo, "linkdir"));
    expect((await decide("Read", { file_path: "src/link" })).allowed).toBe(false);
    expect((await decide("Read", { file_path: "linkdir/secret" })).allowed).toBe(false);
    expect((await decide("Glob", { pattern: "*", path: "linkdir" })).allowed).toBe(false);
    expect((await decide("Read", { file_path: "linkdir/missing" })).allowed).toBe(false);
  });

  it("allows a symlink that stays inside the repo", async () => {
    await symlink(path.join(repo, "src", "index.ts"), path.join(repo, "alias.ts"));
    expect((await decide("Read", { file_path: "alias.ts" })).allowed).toBe(true);
  });

  it("works when the repo itself is reached through a symlink", async () => {
    const linkedRepo = path.join(sandbox, "linked-repo");
    await symlink(repo, linkedRepo);
    expect((await decide("Read", { file_path: "src/index.ts" }, linkedRepo)).allowed).toBe(true);
    expect(
      (await decide("Read", { file_path: path.join(repo, "src/index.ts") }, linkedRepo)).allowed,
    ).toBe(true);
  });
});

describe("guard hook", () => {
  it("blocks the call (exit 2) when the guard can't be loaded", async () => {
    const hook = path.join(sandbox, "guard-hook.ts");
    await copyFile(new URL("./guard-hook.ts", import.meta.url), hook);
    const run = spawnSync(process.execPath, [hook, repo, path.join(sandbox, "denied.log")], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "src/index.ts" } }),
    });
    expect(run.status).toBe(2);
    expect(run.stderr.toString()).toContain("review-flow guard failed");
  });
});
