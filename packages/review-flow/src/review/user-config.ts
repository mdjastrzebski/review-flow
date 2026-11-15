import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { HARNESSES, type Harness } from "./models.ts";

/** Only the keys implemented so far; other keys in the file are kept on write. */
export interface UserConfig {
  harness?: Harness;
}

export function userConfigPath(): string {
  return path.join(homedir(), ".review-flow", "config.json");
}

async function readRaw(file: string): Promise<Record<string, unknown>> {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // Fail rather than fall back to {}, so saving can't overwrite a config the user can still fix.
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} must hold a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

export async function readUserConfig(file = userConfigPath()): Promise<UserConfig> {
  const { harness } = await readRaw(file);
  if (harness === undefined) return {};
  if (!HARNESSES.includes(harness as Harness)) {
    throw new Error(`${file}: harness must be one of ${HARNESSES.join(", ")}.`);
  }
  return { harness: harness as Harness };
}

/** Sets `harness` in the user config, creating the file if needed. */
export async function saveUserHarness(harness: Harness, file = userConfigPath()): Promise<void> {
  const raw = await readRaw(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...raw, harness }, null, 2)}\n`);
}
