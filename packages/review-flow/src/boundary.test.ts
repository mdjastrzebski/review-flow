import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Each layer and the layers built on it, which it must not import. */
const FORBIDDEN: Record<string, readonly string[]> = {
  runtime: ["review", "eval", "cli", "agents"],
  review: ["eval", "cli"],
};

describe("layer boundaries", () => {
  for (const [layer, forbidden] of Object.entries(FORBIDDEN)) {
    it(`${layer} imports nothing from the layers built on it`, async () => {
      expect(await importsInto(layer, new Set(forbidden))).toEqual([]);
    });
  }
});

/** `file: specifier` for each relative import in `layer` that resolves into a `forbidden` layer. */
async function importsInto(layer: string, forbidden: ReadonlySet<string>): Promise<string[]> {
  const dir = path.join(SRC_DIR, layer);
  const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  const sources = await Promise.all(
    files.map(async (file) => [file, await readFile(path.join(dir, file), "utf8")]),
  );
  const offending: string[] = [];
  for (const [file = "", source = ""] of sources) {
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const target = path.relative(SRC_DIR, path.resolve(dir, path.dirname(file), specifier));
      if (forbidden.has(target.split(path.sep)[0] ?? "")) offending.push(`${file}: ${specifier}`);
    }
  }
  return offending;
}
