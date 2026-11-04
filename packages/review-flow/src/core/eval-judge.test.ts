import { describe, expect, it } from "vitest";
import type { AgentResult, RunAgent } from "./agent.ts";
import { buildJudgePrompt, judgeCase, matchesOf, type JudgeOutput } from "./eval-judge.ts";
import type { NormalizedFinding } from "./schemas.ts";

function finding(id: string, file = "src/a.py", lineStart = 10): NormalizedFinding {
  return {
    id,
    localId: id,
    title: `title ${id}`,
    file,
    lineStart,
    lineEnd: lineStart + 2,
    category: "correctness",
    severity: "medium",
    claim: `claim ${id}`,
    rationale: "r".repeat(2000),
    suggestedFix: null,
  };
}

const evalCase = {
  id: "c-1",
  title: "feat: a thing",
  bugs: [
    {
      description: "fix: copy the bytes",
      fix: "https://example.com/pull/2",
      locations: [{ file: "src/a.py", start: 20, end: 22 }],
    },
  ],
};

describe("buildJudgePrompt", () => {
  it("lists the bugs with their location and the findings as fenced data", () => {
    const prompt = buildJudgePrompt("{{case}}\n{{bugs}}\n{{findings}}", evalCase, [
      finding("F-001"),
    ]);
    expect(prompt).toContain("feat: a thing");
    expect(prompt).toContain("0. fix: copy the bytes");
    expect(prompt).toContain("src/a.py:20-22");
    expect(prompt).toContain('"id": "F-001"');
    expect(prompt).toContain("claim F-001");
    // Long rationales are cut.
    expect(prompt).not.toContain("r".repeat(2000));
  });
});

describe("buildJudgePrompt with a fix diff", () => {
  const template = "{{case}}\n{{bugs}}\n{{findings}}";

  it("shows the fix diff under its bug, and cuts a long one", () => {
    const short = buildJudgePrompt(template, evalCase, [finding("F-001")], ["-old\n+new"]);
    expect(short).toContain("What the fix changed");
    expect(short).toContain("+new");
    const long = buildJudgePrompt(template, evalCase, [finding("F-001")], ["x".repeat(50_000)]);
    expect(long).toContain("[truncated]");
    expect(long.length).toBeLessThan(20_000);
  });

  it("leaves the prompt as it was when the fix couldn't be fetched", () => {
    const without = buildJudgePrompt(template, evalCase, [finding("F-001")]);
    expect(buildJudgePrompt(template, evalCase, [finding("F-001")], [null])).toBe(without);
  });
});

describe("matchesOf", () => {
  it("drops unknown findings and bugs", () => {
    const output: JudgeOutput = {
      bugs: [
        {
          bug: 0,
          matches: [
            { finding: "F-001", reason: "same flaw" },
            { finding: "F-999", reason: "no such finding" },
          ],
        },
        { bug: 3, matches: [{ finding: "F-001", reason: "no such bug" }] },
      ],
    };
    expect(matchesOf(output, 1, [finding("F-001")])).toEqual(new Map([[0, new Set(["F-001"])]]));
  });
});

describe("judgeCase", () => {
  const fake = (result: Partial<AgentResult<JudgeOutput>>): RunAgent =>
    (async () => ({
      status: "ok",
      output: null,
      rawText: "",
      raw: null,
      error: null,
      costUsd: 0.02,
      usage: null,
      durationMs: 5,
      ...result,
    })) as RunAgent;
  const base = { evalCase, cwd: "/tmp", model: { model: "m", effort: null } };

  it("returns the matched finding ids", async () => {
    const output: JudgeOutput = {
      bugs: [{ bug: 0, matches: [{ finding: "F-002", reason: "same flaw" }] }],
    };
    const result = await judgeCase({
      ...base,
      findings: [finding("F-001"), finding("F-002")],
      runAgent: fake({ output }),
    });
    expect(result).toMatchObject({ status: "ok", costUsd: 0.02 });
    expect(result.status === "ok" && result.matches.get(0)).toEqual(new Set(["F-002"]));
  });

  it("skips the call when there are no findings", async () => {
    let called = false;
    const result = await judgeCase({
      ...base,
      findings: [],
      runAgent: (async () => {
        called = true;
        throw new Error("unexpected");
      }) as RunAgent,
    });
    expect(called).toBe(false);
    expect(result).toMatchObject({ status: "ok", costUsd: 0 });
  });

  it("reports a failed call", async () => {
    const result = await judgeCase({
      ...base,
      findings: [finding("F-001")],
      runAgent: fake({ status: "timeout", error: "timed out" }),
    });
    expect(result).toMatchObject({ status: "failed", error: "timed out", costUsd: 0.02 });
  });
});
