import { describe, expect, it } from "vitest";
import { anchorFinding, buildReview, diffLines, postableItems } from "./post.ts";
import type { NormalizedFinding, Verdict } from "./schemas.ts";

const diff = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 one
-two
+TWO
+three
 four
@@ -20,2 +21,2 @@ fn
 x
+y
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

function finding(
  id: string,
  file: string,
  lineStart: number,
  lineEnd = lineStart,
): NormalizedFinding {
  return {
    id,
    localId: id,
    title: `Title ${id}`,
    file,
    lineStart,
    lineEnd,
    category: "correctness",
    severity: "high",
    claim: `Claim ${id}`,
    rationale: "r",
    suggestedFix: "Do the fix.",
  };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    verdict: "confirmed",
    severity: "high",
    confidence: "high",
    fixCost: "small",
    evidence: [],
    summary: "s",
    fix: { assessment: "sound", detail: "d", betterFix: null },
    ...overrides,
  };
}

describe("diffLines", () => {
  it("lists new-side lines in hunks, added and context, and skips deleted files", () => {
    const lines = diffLines(diff);
    expect([...lines.get("a.ts")!]).toEqual([1, 2, 3, 4, 21, 22]);
    expect(lines.has("gone.ts")).toBe(false);
  });
});

describe("anchorFinding", () => {
  const lines = diffLines(diff);

  it("anchors a range fully in the diff as a multi-line comment", () => {
    expect(anchorFinding(finding("1", "a.ts", 2, 3), lines)).toEqual({ line: 3, startLine: 2 });
  });

  it("anchors a single line", () => {
    expect(anchorFinding(finding("1", "a.ts", 22), lines)).toEqual({ line: 22, startLine: null });
  });

  it("uses the first diff line of a range that is only partly in the diff", () => {
    expect(anchorFinding(finding("1", "a.ts", 18, 21), lines)).toEqual({
      line: 21,
      startLine: null,
    });
  });

  it("returns null outside the diff", () => {
    expect(anchorFinding(finding("1", "a.ts", 10), lines)).toBeNull();
    expect(anchorFinding(finding("1", "other.ts", 1), lines)).toBeNull();
  });
});

describe("postableItems", () => {
  it("drops refuted findings and preselects confirmed medium or higher", () => {
    const findings = ["1", "2", "3", "4"].map((id) => finding(id, "a.ts", 1));
    const items = postableItems(findings, {
      "1": verdict({ verdict: "inconclusive" }),
      "2": verdict({ severity: "low" }),
      "3": verdict({ verdict: "refuted" }),
      "4": verdict(),
    });
    expect(items.map((i) => [i.finding.id, i.preselected])).toEqual([
      ["4", true],
      ["2", false],
      ["1", false],
    ]);
  });
});

describe("buildReview", () => {
  it("puts diff findings inline and the rest in the body, as a COMMENT review", () => {
    const plan = buildReview(
      [
        { finding: finding("1", "a.ts", 2, 3), verdict: verdict() },
        {
          finding: finding("2", "b.ts", 5),
          verdict: verdict({ fix: { assessment: "flawed", detail: "d", betterFix: "Better." } }),
        },
      ],
      diff,
      "abc",
    );
    expect(plan.inline).toEqual(["1"]);
    expect(plan.inBody).toEqual(["2"]);
    expect(plan.payload).toMatchObject({ commit_id: "abc", event: "COMMENT" });
    expect(plan.payload.comments).toEqual([
      {
        path: "a.ts",
        line: 3,
        side: "RIGHT",
        start_line: 2,
        start_side: "RIGHT",
        body: "**Title 1** (high)\n\nClaim 1\n\n**Suggested fix:** Do the fix.",
      },
    ]);
    expect(plan.payload.body).toContain("2 findings · 1 inline · 1 outside the diff, below");
    expect(plan.payload.body).toContain("`b.ts:5`");
    expect(plan.payload.body).toContain("**Suggested fix:** Better.");
    expect(plan.payload.body).toContain("Reviewed with [review-flow]");
  });

  it("opens the body with the run's summary", () => {
    const plan = buildReview(
      [{ finding: finding("1", "a.ts", 2), verdict: verdict() }],
      diff,
      "abc",
      {
        goal: { text: "Add b.", source: "stated" },
        changes: ["Adds b."],
        achieved: { verdict: "yes", gaps: [], extras: [] },
        lookAt: [],
      },
    );
    expect(plan.payload.body).toMatch(
      /^\*\*Goal:\*\* Add b\.\n\n- Adds b\.\n\n\*\*Goal met:\*\* yes\n\n---\n\n1 finding/,
    );
  });
});
