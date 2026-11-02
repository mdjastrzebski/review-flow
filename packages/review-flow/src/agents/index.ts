import type { Harness, RunAgent } from "../core/index.ts";
import { createClaudeAgent } from "./claude.ts";
import { createCursorAgent } from "./cursor.ts";

export interface AgentOptions {
  claudeBin: string;
  cursorBin: string;
}

export function getAgent(harness: Harness, options: AgentOptions): RunAgent {
  switch (harness) {
    case "claude":
      return createClaudeAgent({ bin: options.claudeBin });
    case "cursor":
      return createCursorAgent({ bin: options.cursorBin });
  }
}
