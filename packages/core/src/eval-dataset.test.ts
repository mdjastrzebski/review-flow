import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutName, DEFAULT_DATASET_DIR, loadDataset } from "./eval-dataset.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "review-flow-dataset-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (c: string) => c.repeat(40);

function evalCase(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "clean",
    smoke: false,
    title: "t",
    repo: "https://github.com/o/r",
    pr: "https://github.com/o/r/pull/1",
    base: sha("a"),
    head: sha("b"),
    diff: { files: 1, additions: 1, deletions: 0 },
    bugs: [],
    ...overrides,
  };
}

async function write(file: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, file), JSON.stringify(value));
}

describe("loadDataset", () => {
  it("loads the repo's dataset", async () => {
    const all = await loadDataset(DEFAULT_DATASET_DIR, { smoke: false });
    const smoke = await loadDataset(DEFAULT_DATASET_DIR, { smoke: true });
    expect(all).toHaveLength(35);
    expect(all.filter((c) => c.kind === "bug")).toHaveLength(25);
    expect(smoke).toHaveLength(8);
  });

  it("sorts by id and filters the smoke set", async () => {
    await write("z.json", evalCase("z", { smoke: true }));
    await write("a.json", evalCase("a"));
    await write("notes.txt", "ignored");
    expect((await loadDataset(dir, { smoke: false })).map((c) => c.id)).toEqual(["a", "z"]);
    expect((await loadDataset(dir, { smoke: true })).map((c) => c.id)).toEqual(["z"]);
  });

  it("selects cases by id, within the smoke set when asked", async () => {
    await write("a.json", evalCase("a", { smoke: true }));
    await write("b.json", evalCase("b"));
    await write("c.json", evalCase("c", { smoke: true }));
    const ids = async (smoke: boolean, selected: string[]) =>
      (await loadDataset(dir, { smoke, ids: selected })).map((c) => c.id);
    expect(await ids(false, ["c", "b"])).toEqual(["b", "c"]);
    expect(await ids(true, ["a", "b"])).toEqual(["a"]);
    await expect(ids(true, ["b"])).rejects.toThrow("No smoke cases selected");
    await expect(ids(false, ["a", "x"])).rejects.toThrow("No such case in");
  });

  it("rejects invalid cases, naming the file", async () => {
    await write("bad.json", evalCase("bad", { kind: "bug" }));
    await expect(loadDataset(dir, { smoke: false })).rejects.toThrow(
      /bad\.json: .*bug case needs bugs/s,
    );
  });

  it("rejects duplicate ids and an empty selection", async () => {
    await write("a.json", evalCase("a"));
    await expect(loadDataset(dir, { smoke: true })).rejects.toThrow("No smoke cases selected");
    await write("b.json", evalCase("a"));
    await expect(loadDataset(dir, { smoke: false })).rejects.toThrow("Duplicate case id: a");
  });
});

describe("checkoutName", () => {
  it("uses the last two path segments", () => {
    expect(checkoutName("https://github.com/pallets/click")).toBe("pallets__click");
    expect(checkoutName("https://github.com/pallets/click.git/")).toBe("pallets__click");
    expect(checkoutName("git@github.com:tj/commander.js.git")).toBe("tj__commander.js");
    expect(checkoutName("/tmp/x/remote")).toBe("x__remote");
  });
});
