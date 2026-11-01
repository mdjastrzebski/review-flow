# Progress

What is implemented so far. The target design is [SPEC.md](SPEC.md).

## Status

A working CLI that reviews a branch with agents run through a headless CLI, `claude -p` or Cursor's `agent -p`: one reviewer finds issues, verifiers check each finding, and the result is a ranked report.

```bash
pnpm review-flow review --base main --harness claude   # or --harness cursor
```

## Harnesses

Both spawn the CLI per task, with the prompt on stdin, and read its `stream-json` output line by line ([process.ts](packages/agents/src/process.ts)). Timeouts and Ctrl-C send SIGTERM, then SIGKILL after 5 s.

### claude

`claude -p --output-format stream-json` per task ([claude.ts](packages/agents/src/claude.ts)). The prompt goes on stdin, the output schema with `--json-schema`. Shared context (the diff, for verifiers) goes in a file appended to the system prompt with `--append-system-prompt-file`, because the system prompt is cached as its own block and later sessions can read it; a shared prefix inside the user message is not reused. Tool calls in the stream drive the progress lines. The final `result` message gives the structured output, cost (`total_cost_usd`), and tokens. The binary is set with `--claude-bin` (default `claude`).

### cursor

`agent -p --output-format stream-json --mode ask --sandbox enabled --trust` per task ([cursor.ts](packages/agents/src/cursor.ts)). Cursor has no schema flag or system prompt flag, so the prompt is the shared context, then the task, then the output JSON Schema. The answer is the last JSON object in the result text that fits the schema; if none does, one repair turn resumes the same session (`--resume`) and asks for corrected JSON only. Effort goes in the model id (`claude-opus-5-5[effort=high]`). The `result` message gives tokens but no cost, so cost is computed from the [price table](packages/core/src/prices.ts). The binary is set with `--cursor-bin` (default `agent`).

## Pipeline

`collect → review → normalize → verify → rank → report` ([pipeline.ts](packages/core/src/pipeline.ts))

1. **Collect.** Diff `base...HEAD` (three-dot). Exit cleanly if there are no changes.
2. **Review.** One agent session gets the full diff and read-only repo access, and returns findings as structured JSON ([reviewer.md](packages/core/prompts/reviewer.md)). It is told to report only concrete defects with a failure scenario, at most 15.
3. **Normalize.** Cap at 15 findings, assign ids (`F-001`…), make paths repo-relative, fix reversed line ranges.
4. **Verify.** One fresh agent session per finding, up to 3 in parallel ([verifier.md](packages/core/prompts/verifier.md)). The verifier tries to refute the claim and returns `confirmed`, `refuted`, or `inconclusive`, plus severity, confidence, fix cost, evidence, and an assessment of the suggested fix. To avoid anchoring, it doesn't see the reviewer's rationale, severity, or category. The diff is shared context ([change.md](packages/core/prompts/change.md)), framed as data, not instructions. The first verifier runs alone until its first tool call, so its request has cached the diff before the others start.
5. **Rank.** Rules enforced in code: `confirmed` without a `code_ref` is downgraded to `inconclusive`, and a failed verifier counts as `inconclusive`. Findings are sorted by verdict, then severity, then confidence ([rank.ts](packages/core/src/rank.ts)).
6. **Report.** Markdown report plus a terminal summary.

## Safety

- `claude` agents only get `Read`, `Grep`, and `Glob` (`--tools`, `--allowed-tools`, `--permission-mode dontAsk`). A `PreToolUse` command hook, passed with `--settings`, also denies any other tool and any path outside the repo, following symlinks, and fails closed ([guard.ts](packages/agents/src/guard.ts), [guard-hook.ts](packages/agents/src/guard-hook.ts)).
- `cursor` agents run in ask mode (read-only) with the sandbox on, which refuses shell, writes, MCP, and web fetches. Cursor has no pre-tool hook and still allows reads outside the repo, so each tool call is checked once it completes. A forbidden call Cursor refused is recorded as denied. A read outside the repo that ran is recorded in `outsideReads` in `calls.jsonl` and printed, and the task goes on. Any other forbidden call that ran stops the task with an error. Each Cursor task gets its own empty config dir (`CURSOR_CONFIG_DIR`), so the user's CLI settings (such as a shell allowlist) don't apply and chats aren't saved with theirs. Cursor sessions still see project rules and `AGENTS.md`. Blocking outside reads up front isn't possible: a `Read(...)` deny rule stops the read tool, but deny beats allow (so the repo can't be re-allowed under a deny-all), and glob and grep ignore read rules.
- `claude` sessions are isolated: `--setting-sources ""` (no user or project settings, CLAUDE.md, or AGENTS.md), auto-memory off, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`.
- `git status` is snapshotted before the run and checked after every task. Any change aborts the run.

## Run output

Each run writes `.review-flow/runs/<timestamp>-<sha>/` (added to `.gitignore` automatically):

| File                | Content                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `diff.patch`        | Reviewed diff                                                                                                                              |
| `prompts/<task>.md` | Exact prompt per task                                                                                                                      |
| `raw/<task>.json`   | CLI args, all stream messages, stderr tail, denied tool calls                                                                              |
| `calls.jsonl`       | One line per agent task: role, step, model, effort, status, tokens, cost and cost source, start, duration, reads outside the repo that ran |
| `findings.json`     | Normalized findings                                                                                                                        |
| `verdicts.json`     | Verdict per finding                                                                                                                        |
| `report.md`         | Ranked report                                                                                                                              |
| `run.json`          | Models, base/head SHAs, status, and per-step and total calls, cost, tokens, and wall time                                                  |

Steps in `run.json` are `collect`, `review` (including normalize), `verify` (including the verdict rules), and `report`. Step time is wall time, so `verify` is less than the sum of its parallel calls. A call's cost source is `reported` when the CLI gave a cost, `computed` when its tokens and model are in the price table (standard API prices for Claude 5.5 models, Grok 4.7, and Composer 2.5; fast variants and long-context surcharges are not priced), else `unknown`; `unknownCostCalls` counts them, and when above 0 the cost is a lower bound. `calls.jsonl` is appended as each call ends, so a failed run keeps its records.

## Configuration

CLI flags only: `--base`, `--harness`, `--model` (reviewer, and verifier unless overridden), `--verifier-model`, `--claude-bin`, `--cursor-bin`, `--repo`, `--quiet`.

Defaults ([models.ts](packages/core/src/models.ts)):

- `claude`: Opus 5.5 at `high` effort for the reviewer and at `medium` effort for verifiers.
- `cursor`: `composer-2.5` for both roles. Grok 4.7 high timed out as reviewer after 20 min (see the [decision log](PLAN.md#decision-log)). A `--model` override passes no effort, because not every Cursor model accepts one.

Hard-coded: timeouts (reviewer 20 min, verifier 10 min), verifier concurrency (3), max findings (15), suggested-fix cap (10 lines / 800 chars).

## Observed cost and time

From local runs on this repo (Claude harness, default models, Oct–Nov 2026):

- **Cost:** $0.31–$2.95 per run. A reviewer-only run (no findings) costs $0.31–$0.65.
- **Time:** 1–2.5 min per run.
- **Verification can cost more than the review.** In one run, the reviewer cost $0.72 and 4 verifiers cost $2.23.
- **`claude -p` vs Agent SDK:** on the same diff, $2.21 / 1.7 min vs $2.95 / 2.2 min, with similar findings (see the [decision log](PLAN.md#decision-log)).
- **Cursor with Composer 2.5:** $0.32 / 2.3 min on the comparison diff, a third of Claude's cheapest run, but 1 finding vs Claude's 3–4, missing a high-severity one (see the [decision log](PLAN.md#decision-log)).
- **Cursor with Grok 4.7:** low $1.37 / 9.1 min (5 findings), medium $5.41 / 31.4 min (6 findings, 77 reads outside the repo).
- Cursor reports tokens only when a session finishes, so a task that times out or is stopped has no cost. Two Grok 4.7 high runs failed that way (15.6 and 20 min).
- **Cache writes cost about 40× cache reads** (fitted from `calls.jsonl`: $8 vs $0.20 per million tokens, all at the 1-hour cache). A verifier that reads the diff from cache costs about $0.08 instead of $0.48 (see the [decision log](PLAN.md#decision-log)).
- **Repeat runs on the same diff are cheaper**: the reviewer prompt stays in the 1-hour cache, so a second run within the hour skipped a $0.50 cache write. Compare first runs with first runs.

## Gaps against the [spec](SPEC.md)

- **Usage (2):** `--base` and `--harness` are required. No PR, commit, or range targets, no uncommitted changes. Only `review` exists.
- **Trust (3):** none. Reviews run in the developer's checkout, not a worktree.
- **Pipeline (4):** one finder, no dedupe or filter, one verifier session per finding with the full diff each time.
- **Finding model (5):** no origin, no `unverified`. Pre-existing bugs are not reported.
- **Incremental reviews (6), posting and exit codes (7):** none.
- **Configuration (8):** CLI flags only. No config files, presets, budgets, or `REVIEW.md`.
- **Harnesses (9):** `claude` and `cursor` profiles, hard-coded. No `codex` profile or user profiles. The price table is small and can't be overridden.
- **Instrumentation (10):** no `index.jsonl`, `runs`, or `compare`. Totals with `unknown` calls are not shown as partial. The root `.gitignore` is edited.
- **Evaluation (11), distribution (12):** none.
