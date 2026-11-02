# Progress

What is implemented so far. The target design is [SPEC.md](SPEC.md).

## Status

A working CLI that reviews a branch with agents run through a headless CLI, `claude -p` or Cursor's `agent -p`: one reviewer finds issues, verifiers check each finding, and the result is a ranked report.

```bash
pnpm review-flow review                                # asks for harness and base; or -H claude -b main
pnpm review-flow eval --harness claude --smoke         # score the eval dataset
pnpm review-flow runs                                  # past runs and evals, newest first
pnpm review-flow compare <a> <b>                       # two runs or two evals side by side
```

## Harnesses

Both spawn the CLI per task, with the prompt on stdin, and read its `stream-json` output line by line ([process.ts](packages/agents/src/process.ts)). Timeouts and Ctrl-C send SIGTERM, then SIGKILL after 5 s.

### claude

`claude -p --output-format stream-json` per task ([claude.ts](packages/agents/src/claude.ts)). The prompt goes on stdin, the output schema with `--json-schema`. Shared context (the diff, for verifiers) goes in a file appended to the system prompt with `--append-system-prompt-file`, because the system prompt is cached as its own block and later sessions can read it; a shared prefix inside the user message is not reused. Tool calls in the stream drive the progress lines. The final `result` message gives the structured output, cost (`total_cost_usd`), and tokens. The binary is set with `--claude-bin` (default `claude`).

### cursor

`agent -p --output-format stream-json --mode ask --sandbox enabled --trust` per task ([cursor.ts](packages/agents/src/cursor.ts)). Cursor has no schema flag or system prompt flag, so the prompt is the shared context, then the task, then the output JSON Schema. The answer is the last JSON object in the result text that fits the schema; if none does, one repair turn resumes the same session (`--resume`) and asks for corrected JSON only. Effort goes in the model id (`claude-opus-5-5[effort=high]`). The `result` message gives tokens but no cost, so cost is computed from the [price table](packages/core/src/prices.ts). The binary is set with `--cursor-bin` (default `agent`).

## Pipeline

`collect → review → normalize → verify → rank → report` ([pipeline.ts](packages/core/src/pipeline.ts))

1. **Collect.** Diff `base...HEAD` (three-dot). Uncommitted changes (staged, unstaged, and untracked, respecting `.gitignore`) are included through a snapshot commit on top of `HEAD`, built with a temporary index so the developer's index is untouched; `--committed-only` skips them, and `eval` always does. The CLI prints how many uncommitted files are included, and the prompts say the change is "`HEAD` plus uncommitted changes". Exit cleanly if there are no changes.
2. **Review.** One agent session gets the full diff and read-only repo access, and returns findings as structured JSON ([reviewer.md](packages/core/prompts/reviewer.md)). It is told to report only concrete defects with a failure scenario, at most 15.
3. **Normalize.** Cap at 15 findings, assign ids (`F-001`…), make paths repo-relative, fix reversed line ranges.
4. **Verify.** One fresh agent session per finding, up to 3 in parallel ([verifier.md](packages/core/prompts/verifier.md)). The verifier tries to refute the claim and returns `confirmed`, `refuted`, or `inconclusive`, plus severity, confidence, fix cost, evidence, and an assessment of the suggested fix. To avoid anchoring, it doesn't see the reviewer's rationale, severity, or category. The diff is shared context ([change.md](packages/core/prompts/change.md)), framed as data, not instructions. The first verifier runs alone until its first tool call, so its request has cached the diff before the others start.
5. **Rank.** Rules enforced in code: `confirmed` without a `code_ref` is downgraded to `inconclusive`, and a failed verifier counts as `inconclusive`. Findings are sorted by verdict, then severity, then confidence ([rank.ts](packages/core/src/rank.ts)).
6. **Report.** Markdown report plus a terminal summary.

## Safety

- `claude` agents only get `Read`, `Grep`, and `Glob` (`--tools`, `--allowed-tools`, `--permission-mode dontAsk`). A `PreToolUse` command hook, passed with `--settings`, also denies any other tool and any path outside the repo, following symlinks and expanding a leading `~` as Claude Code does, and fails closed ([guard.ts](packages/agents/src/guard.ts), [guard-hook.ts](packages/agents/src/guard-hook.ts)).
- `cursor` agents run in ask mode (read-only) with the sandbox on, which refuses shell, writes, MCP, and web fetches. Cursor has no pre-tool hook and still allows reads outside the repo, so each tool call is checked once it completes. A forbidden call Cursor refused is recorded as denied. A read outside the repo that ran is recorded in `outsideReads` in `calls.jsonl` and printed, and the task goes on. Any other forbidden call that ran stops the task with an error. Each Cursor task gets its own empty config dir (`CURSOR_CONFIG_DIR`), so the user's CLI settings (such as a shell allowlist) don't apply and chats aren't saved with theirs. Cursor sessions still see project rules and `AGENTS.md`. Blocking outside reads up front isn't possible: a `Read(...)` deny rule stops the read tool, but deny beats allow (so the repo can't be re-allowed under a deny-all), and glob and grep ignore read rules.
- `claude` sessions are isolated: `--setting-sources ""` (no user or project settings, CLAUDE.md, or AGENTS.md), auto-memory off, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`.
- `git status` is snapshotted before the run and checked after every task. Any change aborts the run.

## Run output

Each run writes `.review-flow/runs/<timestamp>-<sha>/` (added to `.gitignore` automatically):

| File                | Content                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diff.patch`        | Reviewed diff                                                                                                                                              |
| `prompts/<task>.md` | Exact prompt per task                                                                                                                                      |
| `raw/<task>.json`   | CLI args, all stream messages, stderr tail, denied tool calls                                                                                              |
| `calls.jsonl`       | One line per agent task: role, step, model, effort, status, tokens, cost and cost source, start, duration, reads outside the repo that ran                 |
| `findings.json`     | Normalized findings                                                                                                                                        |
| `verdicts.json`     | Verdict per finding                                                                                                                                        |
| `report.md`         | Ranked report                                                                                                                                              |
| `run.json`          | Models, base/head SHAs (plus `head.snapshotSha` when uncommitted changes were reviewed), status, and per-step and total calls, cost, tokens, and wall time |

Steps in `run.json` are `collect`, `review` (including normalize), `verify` (including the verdict rules), and `report`. Step time is wall time, so `verify` is less than the sum of its parallel calls. A call's cost source is `reported` when the CLI gave a cost, `computed` when its tokens and model are in the price table (standard API prices for Claude 5.5 models, Grok 4.7, and Composer 2.5; fast variants and long-context surcharges are not priced), else `unknown`; `unknownCostCalls` counts them, and when above 0 the cost is a lower bound. `calls.jsonl` is appended as each call ends, so a failed run keeps its records.

Each run, including a failed one, also appends a summary line to `.review-flow/index.jsonl` ([run-index.ts](packages/core/src/run-index.ts)): id (the run dir name), status, harness, models, base and head, diff size (files, added and removed lines), finding count, verdict counts, cost, unknown-cost calls, and time. Eval runs add one line each, with `kind: "eval"`, the case count, and the scores; their case runs aren't indexed.

## Runs and compare

- `review-flow runs [-n <count>]` lists indexed runs and evals, newest first (default 20). A cost of `≥$x` means some calls had no cost. Eval rows show the case count and recall in place of the diff and findings.
- `review-flow compare <a> <b>` takes a run id, a unique part of one (such as the short SHA), or a run dir path, from the current dir or from `.review-flow/runs/` ([compare.ts](packages/core/src/compare.ts), [runs.ts](packages/cli/src/runs.ts)). Both must be review runs or both evals. It shows the models and diff of each run, cost, time, and calls per step with deltas, and the findings in both runs and in only one. Findings match when they are in the same file and their line ranges are at most 3 lines apart, closest pairs first. When the runs reviewed different commits, it warns that line matching is rough.

## Eval

`review-flow eval [--smoke]` reviews every case of the [dataset](eval/README.md) with the same harness and model flags as `review` ([eval.ts](packages/core/src/eval.ts), [eval-score.ts](packages/core/src/eval-score.ts)).

- **Selection.** All cases, `--smoke` for the smoke set, or `--case <ids...>` for chosen ones (within the smoke set if both are given). [eval/README.md](eval/README.md) has a 3-case recipe for a quick end-to-end check.
- **Checkouts.** One clone per case repo in `~/.cache/review-flow/eval/` (`--checkouts`), cloned on first use and fetched when a case's commit is missing. Each case checks out its head (detached, forced, `git clean -ffdx`) and is reviewed against its base. Cases run one at a time, in id order.
- **Scoring.** A bug is found when a finding that wasn't refuted is in the same file, with lines overlapping or at most 3 apart. Reviewer recall counts refuted findings too. A failed case (clone, checkout, or reviewer failure) is counted but not scored. An agent changing a checkout stops the eval.
- **Eval run.** `.review-flow/runs/<timestamp>-eval/` in the repo the eval is run from (`--repo`): `run.json` (harness, models, dataset, status, scores, per-step totals summed over cases, total wall time including clones), `cases.json` (outcome, finding counts, matched finding ids, cost, and time per case; rewritten after each case), and `cases/<id>/`, a normal run dir per case. Case run dirs live there, not in the checkout, so the checkout's `.gitignore` and index stay untouched.
- **Output.** Progress per case, then a table of case outcomes (`found`, `refuted`, `missed`, `N findings`, `failed`) and the scores: recall, reviewer recall, findings per clean case, failed cases, and cost and time per case. `--quiet` prints only the eval run dir.
- **Compare.** Two evals show their scores and per-step totals with deltas, the cases whose outcome changed, and a warning when they ran different cases. To see one case's findings in two evals: `compare <eval a>/cases/<id> <eval b>/cases/<id>`.

## Configuration

CLI flags, plus `harness` in `~/.review-flow/config.json`: `-b, --base`, `-H, --harness`, `--model` (reviewer, and verifier unless overridden), `--verifier-model`, `--effort` (likewise), `--verifier-effort`, `--claude-bin`, `--cursor-bin`, `--committed-only`, `--repo`, `--quiet`. Without `--base`, `review` fetches `main` (or `master`) from origin and uses `origin/main`, asking to confirm it in a TTY; with no origin or a failed fetch it uses local `main` and warns that it may be stale. Without `--harness`, `review` and `eval` use the saved `harness`; if none is saved, a TTY run asks (default `claude`) and saves the answer, and a non-TTY run fails. `eval` takes the same, minus `--base` and `--committed-only`, plus `--smoke`, `--case`, `--dataset`, and `--checkouts`.

Defaults ([models.ts](packages/core/src/models.ts)):

- `claude`: Sonnet 5.5 at `high` effort for both roles. It matched Opus 5.5 on quality at about half the cost (see the [decision log](PLAN.md#decision-log)).
- `cursor`: `grok-4.7-low` for both roles. Composer 2.5 was cheaper but missed a high-severity bug; Grok 4.7 medium and high were slow and read outside the repo (see the [decision log](PLAN.md#decision-log)). A `--model` override passes no effort unless `--effort` is given, because not every Cursor model accepts one.

Hard-coded: timeouts (reviewer 20 min, verifier 10 min), verifier concurrency (3), max findings (15), suggested-fix cap (10 lines / 800 chars).

## Observed cost and time

From local runs on this repo (Claude harness with the earlier Opus 5.5 defaults unless noted, Oct–Nov 2026):

- **Cost:** $0.31–$2.95 per run. A reviewer-only run (no findings) costs $0.31–$0.65.
- **Time:** 1–2.5 min per run.
- **Verification can cost more than the review.** In one run, the reviewer cost $0.72 and 4 verifiers cost $2.23.
- **`claude -p` vs Agent SDK:** on the same diff, $2.21 / 1.7 min vs $2.95 / 2.2 min, with similar findings (see the [decision log](PLAN.md#decision-log)).
- **Claude models and effort (same effort for both roles):** Opus high $1.22, medium $0.48, low $0.58; Sonnet high $0.65, medium $0.38; 0.7–2.4 min. Costs are lower than cold because the runs shared cache; see the [decision log](PLAN.md#decision-log) for estimates.
- **Cursor with Composer 2.5:** $0.32 / 2.3 min on the comparison diff, a third of Claude's cheapest run, but 1 finding vs Claude's 3–4, missing a high-severity one (see the [decision log](PLAN.md#decision-log)).
- **Cursor with Grok 4.7:** low $1.37 / 9.1 min (5 findings), medium $5.41 / 31.4 min (6 findings, 77 reads outside the repo).
- Cursor reports tokens only when a session finishes, so a task that times out or is stopped has no cost. Two Grok 4.7 high runs failed that way (15.6 and 20 min).
- **Cache writes cost about 40× cache reads** (fitted from `calls.jsonl`: $8 vs $0.20 per million tokens, all at the 1-hour cache). A verifier that reads the diff from cache costs about $0.08 instead of $0.48 (see the [decision log](PLAN.md#decision-log)).
- **Repeat runs on the same diff are cheaper**: the reviewer prompt stays in the 1-hour cache, so a second run within the hour skipped a $0.50 cache write. Compare first runs with first runs.

## Gaps against the [spec](SPEC.md)

- **Usage (2):** `--harness` (or a saved one) is required without a TTY; installed CLIs aren't detected. No PR, branch, commit, or range targets. Only `review`, `eval`, `runs`, and `compare` exist.
- **Trust (3):** none. Reviews run in the developer's checkout, not a worktree.
- **Pipeline (4):** one finder, no dedupe or filter, one verifier session per finding with the full diff each time.
- **Finding model (5):** no origin, no `unverified`. Pre-existing bugs are not reported.
- **Incremental reviews (6), posting and exit codes (7):** none.
- **Configuration (8):** CLI flags and the saved `harness` only. No other config keys, no JSONC or project files, presets, budgets, or `REVIEW.md`.
- **Harnesses (9):** `claude` and `cursor` profiles, hard-coded. No `codex` profile or user profiles. The price table is small and can't be overridden.
- **Instrumentation (10):** the index has no preset, config hash, or `REVIEW.md` hash, since none of those exist yet. Runs from before the index aren't listed by `runs`, though `compare` still takes their ids if their `run.json` has per-step records. The report and terminal summary don't mark totals with `unknown` calls as partial. The root `.gitignore` is edited.
- **Evaluation (11):** the dataset and `eval` command exist; no baseline yet. Cases run one at a time, so the full set takes about an hour. Two evals at once must use different `--checkouts`.
- **Distribution (12):** none.
