import type { ModelChoice } from "./models.ts";
import type { NormalizedFinding } from "./schemas.ts";

export function describeModel({ model, effort }: ModelChoice): string {
  const name = model ?? "harness default";
  return effort === null ? name : `${name} (effort: ${effort})`;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

/** `file:line` or `file:start-end`. */
export function formatLocation({
  file,
  lineStart,
  lineEnd,
}: Pick<NormalizedFinding, "file" | "lineStart" | "lineEnd">): string {
  return lineStart === lineEnd ? `${file}:${lineStart}` : `${file}:${lineStart}-${lineEnd}`;
}
