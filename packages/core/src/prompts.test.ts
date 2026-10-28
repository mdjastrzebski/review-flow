import { describe, expect, it } from "vitest";
import { loadPrompt, renderPrompt } from "./prompts.ts";

describe("renderPrompt", () => {
  it("replaces every placeholder occurrence", () => {
    expect(renderPrompt("{{a}} and {{b}} and {{a}}", { a: "1", b: "2" })).toBe("1 and 2 and 1");
  });

  it("does not re-expand placeholders inside values", () => {
    expect(renderPrompt("{{diff}}", { diff: "+ {{base}}" })).toBe("+ {{base}}");
  });

  it("throws on a placeholder without a value", () => {
    expect(() => renderPrompt("{{a}} {{b}}", { a: "1" })).toThrow("{{b}}");
  });

  it("throws on a value without a placeholder", () => {
    expect(() => renderPrompt("{{a}}", { a: "1", extra: "x" })).toThrow("extra");
  });
});

describe("reviewer prompt", () => {
  it("renders with base and diff", async () => {
    const prompt = renderPrompt(await loadPrompt("reviewer"), { base: "main", diff: "DIFF" });
    expect(prompt).toContain("`main`");
    expect(prompt).toContain("DIFF");
  });
});
