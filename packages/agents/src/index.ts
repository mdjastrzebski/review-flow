import type { Harness, RunAgent } from "@review-flow/core";
import { createClaudeAgent } from "./claude.ts";

export interface AgentOptions {
  claudeBin: string;
  cursorBin: string;
}

export function getAgent(harness: Harness, options: AgentOptions): RunAgent {
  switch (harness) {
    case "claude":
      return createClaudeAgent({ bin: options.claudeBin });
    case "cursor":
      throw new Error("The cursor harness is not implemented yet.");
  }
}
