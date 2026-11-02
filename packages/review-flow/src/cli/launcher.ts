/**
 * How the user started review-flow, so commands we print can be copied as-is: `npx review-flow`,
 * `pnpm review-flow` (from source), or `review-flow` (installed).
 */
export function launcher(env: NodeJS.ProcessEnv = process.env): string {
  if (env.npm_command === "exec") return "npx review-flow";
  if (env.npm_lifecycle_event === "review-flow") return "pnpm review-flow";
  return "review-flow";
}
