import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "./models.ts";
import {
  appendIndexEntry,
  diffStats,
  indexPath,
  readIndex,
  resolveRun,
  runsPath,
  type IndexEntry,
} from "./run-index.ts";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "review-flow-index-"));
  await mkdir(runsPath(repo), { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function entry(id: string): IndexEntry {
  return {
    id,
    kind: "review",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 1000,
    status: "ok",
    harness: "claude",
    models: DEFAULT_MODELS.claude,
    base: { ref: "main", sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    diff: { files: 1, additions: 1, deletions: 0 },
    findings: 1,
    verdicts: { confirmed: 1, inconclusive: 0, refuted: 0 },
    costUsd: 0.5,
    unknownCostCalls: 0,
  };
}

describe("diffStats", () => {
  it("counts files and hunk lines, not file headers", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " same",
      "-old",
      "--- removed line that looks like a header",
      "+new",
      "diff --git a/y b/y",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/y",
      "@@ -0,0 +1 @@",
      "+added",
      "",
    ].join("\n");
    expect(diffStats(diff)).toEqual({ files: 2, additions: 2, deletions: 2 });
  });
});

describe("index", () => {
  it("reads nothing when there is no index", async () => {
    expect(await readIndex(repo)).toEqual([]);
  });

  it("appends entries and skips unparsable lines", async () => {
    await appendIndexEntry(repo, entry("one"));
    await writeFile(indexPath(repo), "{truncated\n", { flag: "a" });
    await appendIndexEntry(repo, entry("two"));
    expect((await readIndex(repo)).map((e) => e.id)).toEqual(["one", "two"]);
  });
});

describe("resolveRun", () => {
  const ids = ["20261101-100000-abc1234", "20261101-110000-abc1234", "20261101-120000-def5678"];

  beforeEach(async () => {
    for (const id of ids) {
      await mkdir(path.join(runsPath(repo), id));
      await writeFile(path.join(runsPath(repo), id, "run.json"), "{}");
    }
    await appendIndexEntry(repo, entry(ids[0] as string));
  });

  it("resolves an exact id or a unique part of one, including unindexed runs", async () => {
    expect(await resolveRun(repo, ids[0] as string, repo)).toEqual({
      id: ids[0],
      root: path.join(runsPath(repo), ids[0] as string),
    });
    expect((await resolveRun(repo, "def5678", repo)).id).toBe(ids[2]);
  });

  it("resolves a run dir path relative to cwd", async () => {
    const result = await resolveRun(repo, `runs/${ids[1]}`, path.join(repo, ".review-flow"));
    expect(result.id).toBe(ids[1]);
  });

  it("rejects unknown and ambiguous refs", async () => {
    await expect(resolveRun(repo, "nope", repo)).rejects.toThrow('No run matches "nope"');
    await expect(resolveRun(repo, "abc1234", repo)).rejects.toThrow("matches 2 runs");
  });
});
