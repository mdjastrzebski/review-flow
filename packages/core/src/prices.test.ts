import { describe, expect, it } from "vitest";
import { computeCostUsd } from "./prices.ts";

const usage = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

describe("computeCostUsd", () => {
  it("prices each token kind", () => {
    expect(computeCostUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 0.2 + 5 + 20);
  });

  it("ignores effort in brackets or as a suffix", () => {
    expect(computeCostUsd("claude-opus-5-5[effort=high]", usage)).toBeCloseTo(29.2);
    expect(computeCostUsd("grok-4.7-high", usage)).toBeCloseTo(2 + 0.5 + 2 + 6);
    expect(computeCostUsd("grok-4.7-medium", usage)).toBeCloseTo(10.5);
    expect(computeCostUsd("composer-2.5", usage)).toBeCloseTo(0.5 + 0.2 + 0.5 + 2.5);
  });

  it("returns null for fast variants, unknown models, or missing tokens", () => {
    expect(computeCostUsd("claude-opus-5-5[fast=true]", usage)).toBeNull();
    expect(computeCostUsd("grok-4.7-high-fast", usage)).toBeNull();
    expect(computeCostUsd("composer-2.5-fast", usage)).toBeNull();
    expect(computeCostUsd("gpt-x", usage)).toBeNull();
    expect(computeCostUsd(null, usage)).toBeNull();
    expect(computeCostUsd("claude-opus-5-5", null)).toBeNull();
  });
});
