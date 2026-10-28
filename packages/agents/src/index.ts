import type { Harness, RunAgent } from "@review-flow/core";
import { runClaudeAgent } from "./claude.ts";

export interface AgentOptions {
  cursorBin: string;
}

export function getAgent(harness: Harness, _options: AgentOptions): RunAgent {
  switch (harness) {
    case "claude":
      return runClaudeAgent;
    case "cursor":
      throw new Error("The cursor harness is not implemented yet.");
  }
}
