/**
 * `PreToolUse` command hook for `claude -p`, passed with `--settings`.
 * Usage: node guard-hook.ts <repo> <denied-log>
 * Reads the hook input on stdin, prints a deny decision when the call isn't allowed, and appends
 * each denial to <denied-log>. Any failure blocks the call (exit 2), so the guard fails closed.
 */
import { appendFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import type { ToolCall } from "./guard.ts";

const [cwd, deniedLog] = process.argv.slice(2);

try {
  if (cwd === undefined || deniedLog === undefined) throw new Error("usage: <repo> <denied-log>");
  // Loaded here, not at the top, so a load failure also exits 2 instead of letting the call through.
  const { guardToolCall } = await import("./guard.ts");
  const call = JSON.parse(await text(process.stdin)) as ToolCall;
  const reason = await guardToolCall(cwd, call);
  if (reason !== null) {
    await appendFile(deniedLog, `${call.tool_name}: ${reason}\n`);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
} catch (error) {
  process.stderr.write(
    `review-flow guard failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 2;
}
