import type { TokenUsage } from "./agent.ts";

/** USD per million tokens. */
export interface Price {
  input: number;
  cacheRead: number;
  /**
   * Claude: the 5-minute cache write (1.25× input); harnesses that need computed cost don't say
   * which TTL. Grok and Composer: no write surcharge listed, so the input price.
   */
  cacheWrite: number;
  output: number;
}

/**
 * Standard (not fast, not long-context) API prices, checked on 2026-11-01: Anthropic's price list
 * for Claude, Cursor's model page for Grok (same as xAI's list price) and Composer.
 */
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "grok-4.7": { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 6 },
  "composer-2.5": { input: 0.5, cacheRead: 0.2, cacheWrite: 0.5, output: 2.5 },
};

/** Effort suffixes in Cursor model ids, e.g. `grok-4.7-high`; effort doesn't change the price. */
const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|max)$/;

/** The price-table key for a model id, or null when the id names a fast (premium) variant. */
function priceKey(model: string): string | null {
  // Bracketed parameters: `claude-opus-5-5[effort=high]`.
  const params = /\[(.*)\]$/.exec(model)?.[1] ?? "";
  const id = model.replace(/\[.*\]$/, "");
  if (/\bfast=true\b/.test(params) || id.endsWith("-fast")) return null;
  return id.replace(EFFORT_SUFFIX, "");
}

/**
 * Tokens × the price table (cost source `computed`, spec 9). Returns null for a model not in the
 * table. Long-context surcharges (Grok above 256k input tokens) are not applied.
 */
export function computeCostUsd(model: string | null, usage: TokenUsage | null): number | null {
  if (model === null || usage === null) return null;
  const key = priceKey(model);
  const price = key === null ? undefined : PRICES[key];
  if (price === undefined) return null;
  const perToken = (tokens: number, usdPerMillion: number) => (tokens * usdPerMillion) / 1e6;
  return (
    perToken(usage.input, price.input) +
    perToken(usage.cacheRead, price.cacheRead) +
    perToken(usage.cacheWrite, price.cacheWrite) +
    perToken(usage.output, price.output)
  );
}
