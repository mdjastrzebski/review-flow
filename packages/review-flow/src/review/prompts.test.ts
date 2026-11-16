import { describe, expect, it } from "vitest";
import { buildReviewerPrompt } from "./flows/find.ts";

describe("buildReviewerPrompt", () => {
  const change = { base: "main", head: "`HEAD`" };

  it("renders with base, diff and rough edges", () => {
    const prompt = buildReviewerPrompt(change, "DIFF", true);
    expect(prompt).toContain("`main`");
    expect(prompt).toContain("## Rough edges");
    expect(prompt).toContain("DIFF");
  });

  it("leaves the rough edge section out when not asked for", () => {
    expect(buildReviewerPrompt(change, "DIFF", false)).not.toContain("## Rough edges");
  });
});
