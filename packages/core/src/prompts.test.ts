import { describe, expect, it } from "vitest";
import { codeFence, loadPrompt, renderPrompt } from "./prompts.ts";

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

describe("codeFence", () => {
  it("uses a plain triple-backtick fence by default", () => {
    expect(codeFence("x", "diff")).toBe("```diff\nx\n```");
  });

  it("uses a fence longer than any backtick run in the text", () => {
    expect(codeFence(" ```\na ````` b")).toBe("``````\n ```\na ````` b\n``````");
  });
});

describe("reviewer prompt", () => {
  it("renders with base and diff", async () => {
    const prompt = renderPrompt(await loadPrompt("reviewer"), {
      base: "main",
      diffBlock: codeFence("DIFF", "diff"),
    });
    expect(prompt).toContain("`main`");
    expect(prompt).toContain("DIFF");
  });
});
