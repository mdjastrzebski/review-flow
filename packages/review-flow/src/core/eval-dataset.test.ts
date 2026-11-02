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
    preset: "full",
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
    const all = await loadDataset(DEFAULT_DATASET_DIR);
    const baseline = await loadDataset(DEFAULT_DATASET_DIR, { subset: "baseline" });
    expect(all).toHaveLength(35);
    expect(all.filter((c) => c.kind === "bug")).toHaveLength(25);
    expect(baseline).toHaveLength(12);
    const smoke = await loadDataset(DEFAULT_DATASET_DIR, { subset: "smoke" });
    expect(smoke).toHaveLength(5);
    expect(smoke.every((c) => c.preset === "smoke")).toBe(true);
  });

  it("sorts by id and filters by subset", async () => {
    await write("z.json", evalCase("z", { preset: "smoke" }));
    await write("y.json", evalCase("y", { preset: "baseline" }));
    await write("a.json", evalCase("a"));
    await write("notes.txt", "ignored");
    expect((await loadDataset(dir)).map((c) => c.id)).toEqual(["a", "y", "z"]);
    expect((await loadDataset(dir, { subset: "baseline" })).map((c) => c.id)).toEqual(["y", "z"]);
    expect((await loadDataset(dir, { subset: "smoke" })).map((c) => c.id)).toEqual(["z"]);
    expect((await loadDataset(dir, { subset: "full" })).map((c) => c.id)).toEqual(["a", "y", "z"]);
  });

  it("selects cases by id, within the subset when asked", async () => {
    await write("a.json", evalCase("a", { preset: "baseline" }));
    await write("b.json", evalCase("b"));
    await write("c.json", evalCase("c", { preset: "baseline" }));
    const ids = async (subset: "baseline" | undefined, selected: string[]) =>
      (await loadDataset(dir, { subset, ids: selected })).map((c) => c.id);
    expect(await ids(undefined, ["c", "b"])).toEqual(["b", "c"]);
    expect(await ids("baseline", ["a", "b"])).toEqual(["a"]);
    await expect(ids("baseline", ["b"])).rejects.toThrow("No baseline cases selected");
    await expect(ids(undefined, ["a", "x"])).rejects.toThrow("No such case in");
  });

  it("rejects invalid cases, naming the file", async () => {
    await write("bad.json", evalCase("bad", { kind: "bug" }));
    await expect(loadDataset(dir)).rejects.toThrow(/bad\.json: .*bug case needs bugs/s);
  });

  it("rejects an unknown preset", async () => {
    await write("s.json", evalCase("s", { preset: "quick" as never }));
    await expect(loadDataset(dir)).rejects.toThrow(/s\.json: /);
  });

  it("rejects duplicate ids and an empty selection", async () => {
    await write("a.json", evalCase("a"));
    await expect(loadDataset(dir, { subset: "baseline" })).rejects.toThrow(
      "No baseline cases selected",
    );
    await write("b.json", evalCase("a"));
    await expect(loadDataset(dir)).rejects.toThrow("Duplicate case id: a");
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
