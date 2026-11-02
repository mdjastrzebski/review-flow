import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUserConfig, saveUserHarness } from "./user-config.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "review-flow-config-"));
  file = path.join(dir, ".review-flow", "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("user config", () => {
  it("is empty when the file doesn't exist", async () => {
    expect(await readUserConfig(file)).toEqual({});
  });

  it("saves the harness, creating the file, and reads it back", async () => {
    await saveUserHarness("cursor", file);

    expect(await readUserConfig(file)).toEqual({ harness: "cursor" });
  });

  it("keeps other keys when saving", async () => {
    await saveUserHarness("claude", file);
    await writeFile(file, JSON.stringify({ harness: "claude", preset: "deep" }));

    await saveUserHarness("cursor", file);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ harness: "cursor", preset: "deep" });
  });

  it("names the file when it isn't valid JSON, and doesn't overwrite it", async () => {
    await saveUserHarness("claude", file);
    await writeFile(file, "{ harness: ");

    await expect(readUserConfig(file)).rejects.toThrow(`${file} is not valid JSON: `);
    await expect(saveUserHarness("cursor", file)).rejects.toThrow(/is not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{ harness: ");
  });

  it("rejects an unknown harness", async () => {
    await saveUserHarness("claude", file);
    await writeFile(file, JSON.stringify({ harness: "codex" }));

    await expect(readUserConfig(file)).rejects.toThrow(/harness must be one of claude, cursor/);
  });
});
