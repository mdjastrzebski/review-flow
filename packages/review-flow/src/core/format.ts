import type { ModelChoice } from "./models.ts";
import type { NormalizedFinding } from "./schemas.ts";

/** `file:line` or `file:start-end`. */
export function formatLocation({ file, lineStart, lineEnd }: NormalizedFinding): string {
  return lineStart === lineEnd ? `${file}:${lineStart}` : `${file}:${lineStart}-${lineEnd}`;
}

/** `42s` or `3m 7s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

export function describeModel({ model, effort }: ModelChoice): string {
  const name = model ?? "harness default";
  return effort === null ? name : `${name} (effort: ${effort})`;
}
