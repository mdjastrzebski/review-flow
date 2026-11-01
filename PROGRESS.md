# Progress

What is implemented so far. The target design is [SPEC.md](SPEC.md).

## Status

A working CLI that reviews a branch with Claude agents: one reviewer finds issues, verifiers check each finding, and the result is a ranked report. Only the `claude` harness works. `cursor` can be selected but throws "not implemented".

```bash
pnpm review-flow review --base main --harness claude
```

## Pipeline

`collect → review → normalize → verify → rank → report` ([pipeline.ts](packages/core/src/pipeline.ts))

1. **Collect.** Diff `base...HEAD` (three-dot). Exit cleanly if there are no changes.
2. **Review.** One agent session gets the full diff and read-only repo access, and returns findings as structured JSON ([reviewer.md](packages/core/prompts/reviewer.md)). It is told to report only concrete defects with a failure scenario, at most 15.
3. **Normalize.** Cap at 15 findings, assign ids (`F-001`…), make paths repo-relative, fix reversed line ranges.
4. **Verify.** One fresh agent session per finding, up to 3 in parallel ([verifier.md](packages/core/prompts/verifier.md)). The verifier tries to refute the claim and returns `confirmed`, `refuted`, or `inconclusive`, plus severity, confidence, fix cost, evidence, and an assessment of the suggested fix. To avoid anchoring, it doesn't see the reviewer's rationale, severity, or category.
5. **Rank.** Rules enforced in code: `confirmed` without a `code_ref` is downgraded to `inconclusive`, and a failed verifier counts as `inconclusive`. Findings are sorted by verdict, then severity, then confidence ([rank.ts](packages/core/src/rank.ts)).
6. **Report.** Markdown report plus a terminal summary.

## Safety

- Agents only get `Read`, `Grep`, and `Glob`. A `PreToolUse` hook also denies any other tool and any path outside the repo, following symlinks ([guard.ts](packages/agents/src/guard.ts)).
- Sessions are isolated: no user or project settings, no CLAUDE.md, no saved session.
- `git status` is snapshotted before the run and checked after every task. Any change aborts the run.

## Run output

Each run writes `.review-flow/runs/<timestamp>-<sha>/` (added to `.gitignore` automatically):

| File                | Content                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `diff.patch`        | Reviewed diff                                                                                    |
| `prompts/<task>.md` | Exact prompt per task                                                                            |
| `raw/<task>.json`   | All harness messages, plus denied tool calls                                                     |
| `findings.json`     | Normalized findings                                                                              |
| `verdicts.json`     | Verdict per finding                                                                              |
| `report.md`         | Ranked report                                                                                    |
| `run.json`          | Models, base/head SHAs, status, total cost and duration, and status, cost, and duration per task |

## Configuration

CLI flags only: `--base`, `--harness`, `--model` (reviewer, and verifier unless overridden), `--verifier-model`, `--repo`, `--quiet`.

Defaults for the `claude` harness: Opus 5.5 at `high` effort for the reviewer and at `medium` effort for verifiers ([models.ts](packages/core/src/models.ts)).

Hard-coded: timeouts (reviewer 20 min, verifier 10 min), verifier concurrency (3), max findings (15), suggested-fix cap (10 lines / 800 chars).

## Observed cost and time

From local runs on this repo (Claude harness, default models, Oct 2026):

- **Cost:** $0.31–$2.95 per run. A reviewer-only run (no findings) costs $0.31–$0.65.
- **Time:** 1–2.5 min per run.
- **Verification can cost more than the review.** In one run, the reviewer cost $0.72 and 4 verifiers cost $2.23.
- Experimental Cursor runs took 10–27 min and reported no cost.

## Gaps against the [spec](SPEC.md)

- **Usage (2):** `--base` and `--harness` are required. No PR, commit, or range targets, no uncommitted changes. Only `review` exists.
- **Trust (3):** none. Reviews run in the developer's checkout, not a worktree.
- **Pipeline (4):** one finder, no dedupe or filter, one verifier session per finding with the full diff each time.
- **Finding model (5):** no origin, no `unverified`. Pre-existing bugs are not reported.
- **Incremental reviews (6), posting and exit codes (7):** none.
- **Configuration (8):** CLI flags only. No config files, presets, budgets, or `REVIEW.md`.
- **Harnesses (9):** uses the Claude Agent SDK, not headless CLIs.
- **Instrumentation (10):** cost and time per task only. No token breakdown, per-step totals, `index.jsonl`, or `compare`. The root `.gitignore` is edited.
- **Evaluation (11), distribution (12):** none.
