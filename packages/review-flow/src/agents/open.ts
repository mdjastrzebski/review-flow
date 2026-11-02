import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness, ModelChoice } from "../core/index.ts";
import { claudeOpenArgs, guardSettings } from "./claude.ts";
import { cursorOpenArgs } from "./cursor.ts";
import type { AgentOptions } from "./index.ts";

export interface OpenOptions {
  cwd: string;
  model: ModelChoice;
  /** The diff and the answerer's instructions. */
  context: string;
}

/**
 * Hands the terminal to the harness's interactive CLI in `cwd`, with the same read-only flags and
 * isolation as headless tasks. Resolves when the CLI exits; the error is null on exit code 0.
 */
export async function openInteractive(
  harness: Harness,
  bins: AgentOptions,
  options: OpenOptions,
): Promise<{ error: string | null }> {
  const scratch = await mkdtemp(path.join(tmpdir(), "review-flow-open-"));
  try {
    let bin: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    if (harness === "claude") {
      const contextFile = path.join(scratch, "context.md");
      await writeFile(contextFile, options.context);
      const settings = guardSettings(options.cwd, path.join(scratch, "denied.log"));
      bin = bins.claudeBin;
      args = claudeOpenArgs(options.model, settings, contextFile);
      env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
    } else {
      // No system prompt flag: the context is the first message. An empty config dir keeps the
      // user's CLI settings (such as a shell allowlist) out, as in headless tasks.
      await writeFile(
        path.join(scratch, "cli-config.json"),
        JSON.stringify({ version: 1, permissions: { allow: [], deny: [] } }),
      );
      bin = bins.cursorBin;
      args = [...cursorOpenArgs(options.model), options.context];
      env = { ...process.env, CURSOR_CONFIG_DIR: scratch };
    }
    return await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: options.cwd, stdio: "inherit", env });
      child.once("error", (error) => resolve({ error: `Could not run ${bin}: ${error.message}` }));
      child.once("close", (code, signal) =>
        resolve({
          error: code === 0 ? null : `${bin} exited with ${signal ?? `code ${code}`}`,
        }),
      );
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
