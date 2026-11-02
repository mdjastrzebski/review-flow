import { describe, expect, it } from "vitest";
import { parseSelection } from "./prompt.ts";

describe("parseSelection", () => {
  it("parses numbers and ranges into sorted 0-based indexes", () => {
    expect(parseSelection("3, 1-2 2", 4)).toEqual([0, 1, 2]);
  });

  it("rejects malformed or out-of-range input", () => {
    expect(parseSelection("x", 3)).toBeNull();
    expect(parseSelection("0", 3)).toBeNull();
    expect(parseSelection("2-4", 3)).toBeNull();
    expect(parseSelection("3-2", 3)).toBeNull();
  });
});
