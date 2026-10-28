import { realpath } from "node:fs/promises";
import path from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

/** The SDK delivers `outputFormat` results through this internal tool; it has no side effects. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const GUARD_ALLOWED_TOOLS = new Set([...READ_ONLY_TOOLS, STRUCTURED_OUTPUT_TOOL]);

/** Tool-input keys that carry a filesystem path, across Read/Grep/Glob. */
const PATH_KEYS = ["file_path", "path"];

/** Tool-input keys that carry a glob, which resolves against `path` and can escape it. */
const GLOB_KEYS: Record<string, string> = { Glob: "pattern", Grep: "glob" };

/** Resolves symlinks; for a path that doesn't exist, resolves its nearest existing ancestor. */
async function realpathOfNearest(target: string): Promise<string> {
  let existing = target;
  for (;;) {
    try {
      return path.join(await realpath(existing), path.relative(existing, target));
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      existing = parent;
    }
  }
}

async function isInside(realRoot: string, root: string, candidate: string): Promise<boolean> {
  const real = await realpathOfNearest(path.resolve(root, candidate));
  const relative = path.relative(realRoot, real);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function globEscapes(glob: string): boolean {
  return path.isAbsolute(glob) || glob.startsWith("~") || glob.split(/[\\/]/).includes("..");
}

/**
 * Second line of defence behind `tools`/`allowedTools`: deny anything that isn't a read-only tool,
 * and keep reads inside the repo, following symlinks.
 */
export function readOnlyGuard(cwd: string, denied: string[]): HookCallback {
  let realRoot: Promise<string> | null = null;
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const deny = (reason: string) => {
      denied.push(`${input.tool_name}: ${reason}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: reason,
        },
      };
    };

    if (!GUARD_ALLOWED_TOOLS.has(input.tool_name)) {
      return deny(`${input.tool_name} is not available; this session is read-only.`);
    }
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    realRoot ??= realpathOfNearest(path.resolve(cwd));
    for (const key of PATH_KEYS) {
      const value = toolInput[key];
      if (typeof value === "string" && !(await isInside(await realRoot, cwd, value))) {
        return deny(`${value} is outside the repository.`);
      }
    }
    const globKey = GLOB_KEYS[input.tool_name];
    const glob = globKey === undefined ? undefined : toolInput[globKey];
    if (typeof glob === "string" && globEscapes(glob)) {
      return deny(`${glob} must be a relative pattern without "..".`);
    }
    return {};
  };
}
