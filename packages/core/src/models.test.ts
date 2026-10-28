import { describe, expect, it } from "vitest";
import { resolveModels } from "./models.ts";

const none = { model: null, verifierModel: null };

describe("resolveModels", () => {
  it("uses Opus 5.5 high/medium for claude by default", () => {
    expect(resolveModels("claude", none)).toEqual({
      reviewer: { model: "claude-opus-5-5", effort: "high" },
      verifier: { model: "claude-opus-5-5", effort: "medium" },
    });
  });

  it("leaves model and effort to the harness for cursor by default", () => {
    expect(resolveModels("cursor", none)).toEqual({
      reviewer: { model: null, effort: null },
      verifier: { model: null, effort: null },
    });
  });

  it("applies --model to both roles, keeping per-role effort", () => {
    const models = resolveModels("claude", { model: "claude-sonnet-5-5", verifierModel: null });
    expect(models.reviewer).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(models.verifier).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  it("lets --verifier-model override only the verifier", () => {
    const models = resolveModels("claude", {
      model: "claude-fable-5-1",
      verifierModel: "claude-sonnet-5-5",
    });
    expect(models.reviewer.model).toBe("claude-fable-5-1");
    expect(models.verifier.model).toBe("claude-sonnet-5-5");
  });

  it("lets --verifier-model alone keep the default reviewer", () => {
    const models = resolveModels("cursor", { model: null, verifierModel: "gpt-x" });
    expect(models.reviewer.model).toBeNull();
    expect(models.verifier.model).toBe("gpt-x");
  });
});
