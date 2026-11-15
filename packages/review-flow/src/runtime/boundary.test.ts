import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The layers built on the runtime; it must not know about them. */
const FORBIDDEN = new Set(["review", "eval", "cli", "agents"]);

describe("runtime boundary", () => {
  it("imports nothing from the layers built on it", async () => {
    const files = (await readdir(RUNTIME_DIR, { recursive: true })).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const sources = await Promise.all(
      files.map(async (file) => [file, await readFile(path.join(RUNTIME_DIR, file), "utf8")]),
    );
    const offending: string[] = [];
    for (const [file = "", source = ""] of sources) {
      for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const target = path.relative(
          path.dirname(RUNTIME_DIR),
          path.resolve(RUNTIME_DIR, path.dirname(file), specifier),
        );
        if (FORBIDDEN.has(target.split(path.sep)[0] ?? "")) {
          offending.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
