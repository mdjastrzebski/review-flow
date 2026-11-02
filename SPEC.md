# Spec

The target design of review-flow. It follows the [principles](contributing/principles.md) and the [references](contributing/references.md). [PROGRESS.md](PROGRESS.md) describes what exists today.

## 1. Goal and non-goals

review-flow is a local CLI. A developer runs it to review code changes with AI agents: their own work, another branch, or someone else's PR. It summarizes the change for the human reviewer, finds defects, verifies them, and returns a ranked report. For a PR, the developer can post selected findings as a review.

Not in v1 (planned later):

- CI mode and a GitHub Action.
- SDK harnesses, such as the Claude Agent SDK.
- A Claude Code skill or plugin wrapper.

## 2. Usage

```bash
npx review-flow [target]
```

### Commands

| Command                        | Does                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `review-flow [target]`         | Review a target. `review-flow review <target>` is the explicit form, for targets that look like a command name. |
| `review-flow summary [target]` | Summarize a target without looking for defects (see 7). Same targets and base rules as `review`.                |
| `review-flow ask [run]`        | Ask follow-up questions about a reviewed change (default: latest run; see 7).                                   |
| `review-flow post [run]`       | Post selected findings of a run (default: latest) to its PR.                                                    |
| `review-flow eval`             | Run the eval dataset with the current config (see 11).                                                          |
| `review-flow runs`             | List past runs and evals.                                                                                       |
| `review-flow compare <a> <b>`  | Compare two runs or evals: cost, time, and findings or scores, per step.                                        |
| `review-flow config`           | Print the resolved config and where each value came from. `config set <key> <value>` edits a config file.       |
| `review-flow doctor`           | Check `git`, `gh`, installed agent CLIs and their auth, and which harness would be used.                        |

`review` and `eval` print progress: each step and each agent tool call. `--quiet` prints only the run dir. `--verbose` adds what's needed to check the tool works: repo, base and head SHAs, diff size, each agent's command line, session and model, text, refused tool calls, exit code and stderr, tokens and time per call, and step times.

### Targets

| Target                     | Reviews                                       | Base                              |
| -------------------------- | --------------------------------------------- | --------------------------------- |
| none                       | Current branch, including uncommitted changes | Asked; see below                  |
| `<branch>`                 | `base...<branch>`                             | Asked; see below                  |
| `<PR number or URL>`       | `base...<PR head>`                            | The PR's base branch              |
| `<commit>` (full or short) | `commit^..commit`                             | None. Merge commits are rejected. |
| `a..b`                     | `git diff a b`                                | Defined by the range              |
| `a...b`                    | `git diff a...b`                              | Defined by the range              |

When a name is both a branch and a commit hash, the branch wins (git's resolution order).

### Base

When the target needs a base and `--base` is not given:

1. Fetch the default branch: `git fetch origin main` (or `master`).
2. In a TTY, ask for the base, defaulting to `origin/main`. Without a TTY, use the default without asking.
3. If there is no remote or the fetch fails, fall back to local `main` and say so.

A stale local `main` would pull already-merged upstream work into the diff, which adds noise and cost.

### Uncommitted changes

For the current branch, uncommitted changes (staged, unstaged, and untracked, respecting `.gitignore`) are reviewed by default:

- They are captured in a snapshot commit, built with a temporary index (`GIT_INDEX_FILE`, `add -A`, `write-tree`, `commit-tree`). The developer's index, branch, and stash are not touched.
- The CLI prints how many uncommitted files are included. The run records both `HEAD` and the snapshot SHA.
- `--committed-only` reviews `HEAD` instead.
- Runs that include uncommitted changes can't be posted.

## 3. Trust levels

The diff is input to the agents, so it can carry prompt injection. Each target gets a trust level:

| Level          | Targets                                                                        | Detected by                                                                      |
| -------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `own`          | Current checkout, local branches with no upstream, commits on no remote branch | Local git state                                                                  |
| `collaborator` | Branches on `origin`, same-repo PRs                                            | The ref exists on `origin`, or `gh pr view` reports `isCrossRepository == false` |
| `external`     | Fork PRs, and anything that can't be classified (no `gh`, unknown commit)      | `isCrossRepository == true`, or detection failed                                 |

What each level changes:

|                                                     | `own`   | `collaborator`          | `external`                          |
| --------------------------------------------------- | ------- | ----------------------- | ----------------------------------- |
| `best-effort` harness profile (see 9)               | Allowed | Allowed, with a warning | Refused unless `--allow-unenforced` |
| `REVIEW.md` and repo config read from               | Head    | Base                    | Base                                |
| Confirm diff size and cost estimate before spending | No      | No                      | Yes, in a TTY                       |

Reading from the base stops a PR from changing the rules, models, or budgets it is reviewed with. Override the level with `--trust <level>` or a `trust` rule in config, for example to trust branches matching `me/*`. Commit author emails and GitHub author association are not used, because they are easy to fake or don't change the policy.

## 4. Pipeline

```
collect ─┬→ summarize ──────────────────────────────┐
         └→ find → dedupe → verify → filter → rank ─┴→ report → (post)
```

Each step records its own cost and time and can be skipped in config. Values marked _(eval)_ are set by measurement (see 13).

1. **Collect.** Resolve the target, base, and trust level. Create a temporary detached worktree at the target SHA under `.review-flow/worktrees/` and produce the diff. All agents work in that worktree, so the developer's checkout is never touched. The worktree is removed when the run ends, including on failure or Ctrl-C. Stale worktrees are removed at the start of the next run. Exit cleanly when the diff is empty.
2. **Summarize.** One agent call, run in parallel with Find. It gets the same diff as shared context as the verifiers, plus the PR description or commit messages. It writes `summary.json` (see 7). It runs in every preset; skip it with `--no-summary`. A failed call doesn't fail the run: the report says the summary is missing.
3. **Find.** Finder agents read the diff and the surrounding code and return candidate findings as structured JSON. Large diffs are split into file groups, one finder each _(eval: group size)_. The `deep` preset adds finders with a narrow focus, such as security or concurrency. Finders report only concrete defects with a failure scenario.
4. **Dedupe.** Merge findings with the same root cause, so the same bug isn't verified twice. Similar findings across files become one finding for the whole bug class.
5. **Verify.** Verifiers try to refute each finding by reading the code. Findings are batched by file group _(eval: batch size)_ and processed highest finder severity first, so a budget cut loses the least important work. Verifiers don't see the finder's rationale or severity, to avoid anchoring. The `deep` preset uses several verifiers per finding and takes a vote. The verifier sets severity, origin, and verification (see 5).
6. **Filter.** Drop refuted findings and noise: style, cleanup-only, and diagnostic findings _(eval: filter list)_. This applies even when `REVIEW.md` asks for those, unless the filter is disabled in config.
7. **Rank.** Rules enforced in code: `confirmed` without a code reference becomes `inconclusive`, and a failed verifier counts as `inconclusive`. Sort as in 7.
8. **Report.** Write the report and the terminal output from `summary.json` and `findings.json`.
9. **Post.** Optional. See 7.

## 5. Finding model

Each finding has three separate attributes:

| Attribute    | Values                                                                                                                              | Set by                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Severity     | `critical` (data loss, security, outage), `high` (wrong on a common path), `medium` (wrong on an edge case), `low` (minor but real) | Verifier. The finder's value is only a hint. |
| Origin       | `introduced`, `pre-existing`                                                                                                        | Verifier                                     |
| Verification | `confirmed`, `refuted`, `inconclusive`, `unverified`                                                                                | Pipeline                                     |

`inconclusive` means a verifier ran and couldn't decide. `unverified` means no verifier ran, because the preset skips verification or a budget was hit.

A finding also has: an id, file and line range, the claim as a failure scenario, evidence with code references, confidence, fix cost, and a suggested fix with the verifier's assessment of it.

Pre-existing findings are a separate category. They are written to `pre-existing.json`, shown in their own report section, and never offered for posting, because they belong in a separate branch or PR. When a pre-existing bug is the reason a new finding matters, the new finding links to it.

`findings.json` is the stable contract read by the report, `post`, `compare`, and `eval`. It has a published schema.

## 6. Incremental reviews

A review is incremental by default when an earlier run exists for the same target. A run matches when its reviewed head is an ancestor of the current head, or, after a rebase, when the patch-ids match.

- **Summarize** always covers the full diff against the base.
- **Find** sees the full diff against the base as context, but reports only on the interdiff: what changed since the last reviewed SHA.
- **Earlier findings** that were confirmed get a cheap check: `fixed`, `still present`, or `obsolete` (the code is gone). The report shows this in a "Since last review" section.
- **Repeats.** A new finding that matches an earlier one (same file, anchor code, and claim) is not verified or reported again. Findings that were posted or dismissed stay suppressed.
- **Responses.** `fixed` and dismissed outcomes are recorded. They measure noise by developer response and feed the eval.
- `--full` forces a full review. Presets can change the default.

## 7. Output

### Report

`report.md` and the terminal output list:

1. The summary (see below), printed before any findings.
2. Introduced and confirmed findings, by severity. `low` findings are collapsed.
3. Inconclusive findings.
4. Unverified findings.
5. Since last review (incremental runs only).
6. Pre-existing findings.

Refuted findings are kept in the run data and listed last, in their own section, so they are not mistaken for real ones. A footer shows cost, time, preset, and the run directory. A run cut by a budget says so, for example "budget hit at $1.50, 4 of 9 findings verified".

### Summary

A short, human-readable account of the change, so the human can judge it at a high level while the findings cover the details. About 150 words at most:

| Field      | Content                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`     | One sentence, from the PR description or commit messages. Marked `inferred` when neither states it, and "as stated by the author" for `external` targets.      |
| `changes`  | 3 to 6 bullets on behavior, not a file list.                                                                                                                   |
| `achieved` | `yes`, `mostly`, `partly`, or `unclear`, with **gaps** (stated goal missing from the diff) and **extras** (diff outside the goal), each with a code reference. |
| `lookAt`   | 1 to 3 places that need human judgment: new patterns, sensitive areas, scope changes.                                                                          |

`achieved` judges the change against its goal only, not its correctness. Below the summary, the report adds a line with finding counts and coverage (files not read, findings left unverified, budget hit), without a model call. The summary never recommends merging and never comments on style. The PR description is untrusted input and is framed as data in the prompt.

`review-flow summary` runs only Collect and Summarize and prints the same section. Its run is saved like any other, without findings.

### Posting

Posting is never automatic. It is offered in the next-step menu after a PR review in a TTY (see Questions), or run later with `review-flow post [run]`.

1. **Select.** A checkbox list: arrow keys move, Space marks, Enter accepts. The summary comes first, then introduced findings. The summary and confirmed findings of `medium` severity or higher are pre-selected.
2. **Edit.** The user can edit the selected findings' text in `$EDITOR`, since they post under their own name.
3. **Check.** If the PR head moved since the run, warn. The user can post anchored to the reviewed commit (GitHub shows those comments as outdated) or re-run first.
4. **Preview and confirm.** Show exactly what will be posted.
5. **Send.** One GitHub PR review through `gh`, with event `COMMENT`. It never approves or requests changes. Findings on diff lines become inline comments. Findings on other lines go in the review body, together with the summary (when selected) and a "reviewed with review-flow" footer.

Posted findings and their comment ids are saved in the run directory, for repeat suppression and response tracking.

### Questions

After reading the summary or findings, the developer may have follow-up questions, such as "why did the cache key change?" or "what else calls `parseToken`?". `review-flow ask [run]` (default: the latest run) answers them in the terminal. After a review or summary in a TTY, a next-step menu offers: ask a question, post (PR runs only), or done.

- **Context.** The answerer gets the diff as shared context, plus `summary.json`, the findings with their verdicts, and the PR description or commit messages, framed as untrusted data. Follow-ups in the same session read this context from cache.
- **Worktree.** A disposable worktree at the run's head (or snapshot) SHA, so answers describe the reviewed code, not the current checkout. If that commit is gone, a PR run fetches it again; other runs fail with exit `3`.
- **Loop.** Each question is one headless call (see 9), with the same read-only flags, guard hook, and worktree check as the review. Follow-ups get the earlier questions and answers in the prompt, so no saved agent session is needed. An empty line or Ctrl-D ends the session. `ask [run] "<question>"` answers one question and exits.
- **Answers.** Short Markdown, with a code reference (`file:line`) for each claim about the code. The answerer says when it doesn't know, and never recommends merging. Each answer prints its cost and time; the session total prints at the end.
- **Trust.** The run's trust level applies (see 3). The questions are the developer's own input, so they are trusted.
- **Records.** Questions and answers go to `asks.jsonl`, and each call to `calls.jsonl` under step `ask`. Ask cost is kept out of the review totals and the index line, so `compare` and `eval` stay comparable.
- **Role.** `answerer`, set under `roles`. It defaults to the verifier's harness, model, and effort, since both read code to check claims.

`ask --open` hands off to the harness's own interactive CLI (such as `claude`) in the same worktree, with the same context and read-only flags, for longer exploration. The worktree is removed when that CLI exits. Its cost is recorded as `unknown`, and a `best-effort` harness follows the trust rules in 3.

Out of scope: editing code from `ask` (check out the branch for that), and posting answers to the PR.

### Exit codes

| Code  | Meaning                                                                                 |
| ----- | --------------------------------------------------------------------------------------- |
| `0`   | Completed. No introduced, confirmed findings at or above `failOn`.                      |
| `1`   | Completed, with introduced, confirmed findings at or above `failOn`.                    |
| `2`   | Usage or config error. Nothing was spent.                                               |
| `3`   | Run failed: harness error, integrity check, or a refused trust and harness combination. |
| `4`   | Partial. A budget was hit before any finding at or above `failOn` was confirmed.        |
| `130` | Interrupted. Cleanup was done.                                                          |

If a budget was hit after a finding at or above `failOn` was confirmed, the code is `1`. Only introduced, confirmed findings count toward `1`. `failOn` is `critical`, `high`, `medium`, `low`, or `never`, with default `high`.

For other commands, `doctor` returns `0` (ready) or `3` (missing tool or auth), and `post` and `ask` return `0` or `3`.

## 8. Configuration

Zero config gives a `standard` review. The layout follows [agent-browser](https://agent-browser.dev/configuration) and [agent-device](https://oss.callstack.com/agent-device/docs/configuration).

### Files and precedence

From lowest to highest priority:

1. Built-in defaults.
2. The selected preset.
3. User config: `~/.review-flow/config.json` or `config.jsonc`.
4. Project config: `review-flow.json` or `review-flow.jsonc` at the repo root, committed. For `collaborator` and `external` targets it is read from the base.
5. Environment variables: `REVIEW_FLOW_*`, for flat keys only, such as `REVIEW_FLOW_PRESET`.
6. CLI flags.

`--config <path>` or `REVIEW_FLOW_CONFIG` loads one specific file instead of the user and project files.

- All files are parsed as JSONC (comments and trailing commas allowed). Use `.jsonc` for comments so editors don't flag them. When both `.json` and `.jsonc` exist in the same place, that's an error.
- Validation is strict: unknown keys and bad values are errors (exit `2`).
- A published `$schema` gives editor autocomplete.
- `config set` edits values and keeps comments and formatting.
- The resolved config is saved in every run.

### Keys

Keys are camelCase and mirror CLI flags where a flag exists.

| Key           | Holds                                                                |
| ------------- | -------------------------------------------------------------------- |
| `preset`      | Preset name (default `standard`)                                     |
| `harness`     | Harness for every role, unless `roles` overrides it                  |
| `presets`     | Overrides of built-in presets, or new named presets                  |
| `roles`       | Per role (summarizer, finder, verifier, answerer, ...): harness, model, effort |
| `harnesses`   | Harness profiles (see 9)                                             |
| `budget`      | `usd` and `minutes` per run                                          |
| `steps`       | Steps to skip, filter settings                                       |
| `failOn`      | Exit-code threshold (see 7)                                          |
| `trust`       | Trust rules (see 3)                                                  |
| `base`        | Default base branch                                                  |
| `reviewGuide` | Path to the review guide (default `REVIEW.md`)                       |
| `prices`      | Price-table overrides (see 9)                                        |

Long text, such as custom prompts, goes in separate `.md` files that the config points to.

### Presets

`quick`, `standard`, and `deep` are built in. Each sets every pipeline value: finder sharding and focus areas, verification mode, models and effort per role, budgets, `failOn`, and incremental mode. Users override any part of a preset, or define new presets, in config. The built-in values are set by eval.

|              | `quick`       | `standard`                             | `deep`                  |
| ------------ | ------------- | -------------------------------------- | ----------------------- |
| Finders      | One           | Split into file groups for large diffs | Split, plus focus areas |
| Verification | Light or none | Batched                                | Batched, with voting    |
| Models       | Cheaper       | Tuned by eval                          | Strongest               |

### Budgets

Each run has a money limit (USD) and a time limit.

- **Pre-flight.** Show the diff size and an estimated cost range based on past runs. If the estimate is well over the budget, warn, and in a TTY ask before starting.
- **Limit hit.** Stop starting new agent calls, cancel calls in flight, then run filter, rank, and report without agents. Findings that weren't verified are `unverified`. The exit code is `4` or `1` (see 7).
- **Unknown cost.** If a role's harness can only report `unknown` cost (see 9), warn at the start that the money limit can't be enforced for that role. The time limit still applies.

### Review guide

An optional `REVIEW.md` at the repo root tells finders and verifiers what matters in this repo: invariants, risky areas, what counts as a bug, and what to ignore. It is separate from `AGENTS.md` or `CLAUDE.md`, which are written for coding agents, are long, and invite style findings. Its hash is saved in the run.

## 9. Harnesses

A harness runs an agent task: a prompt in, structured output and usage out. There are two kinds:

- `headless` (v1): an agent CLI in non-interactive mode, such as `claude -p`, `codex exec`, or `cursor-agent -p`.
- `sdk` (later): an agent SDK, such as the Claude Agent SDK.

### Headless profiles

Each CLI is described by a profile:

- the command, and how the prompt is passed (argument or stdin);
- where shared context goes: text that is the same for many calls, such as the diff, is sent where the CLI caches it across sessions (`claude`: the system prompt, with `--append-system-prompt-file`; `cursor`, which has no system prompt flag: the start of the prompt), so it is written to the cache once per run instead of once per call;
- the model and effort flags (`cursor` puts effort in the model id: `grok-4.7-high`, `claude-opus-5-5[effort=high]`);
- the read-only flags, and an enforcement level: `enforced` (the CLI blocks writes and shell) or `best-effort` (the agent is only asked to stay read-only);
- structured output: the CLI's schema flag where it exists (`claude --json-schema`, `codex --output-schema`). Otherwise, parse JSON from the text, validate it, and retry once;
- how to read tokens and cost from the output.

`claude`, `codex`, and `cursor` are built in. Users add or override profiles in config, so a new CLI needs no code change.

When no harness is set by a flag or config, review-flow picks an installed supported CLI, preferring `claude` because it reports cost. In a TTY it asks to confirm that pick and saves the answer as `harness` in the user config, so later runs don't ask. The choice is printed. Each role can use a different harness and model.

### Cost

Cost is API-equivalent USD, whatever the user's plan, so runs are comparable. Each call records its cost source:

| Source     | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `reported` | The CLI reported the cost.                                                       |
| `computed` | Tokens × a price table shipped with the tool (dated, overridable with `prices`). |
| `unknown`  | Neither cost nor tokens are available.                                           |

Totals that include `unknown` calls are shown as partial, for example "≥ $1.20". Evals and default tuning use only harnesses with at least token data.

### Safety

Safety is layered, so it doesn't depend on any one CLI:

1. Every review runs in a disposable worktree (see 4).
2. Every profile passes read-only flags. For `claude`, a `PreToolUse` guard hook, passed with `--settings`, also denies other tools and paths outside the worktree, following symlinks. `cursor` has no such hook, so each tool call is checked once it completes. A read outside the worktree that ran is recorded in the call record and the task goes on: the sandbox blocks the network, so what it read can only reach the report. Any other forbidden call that ran stops the task.
3. Sessions are isolated: no user or project agent settings, no memory files, no MCP servers, no saved sessions, as far as each CLI allows.
4. The worktree's state is snapshotted, and checked after every task. Any change aborts the run (exit `3`).
5. Trust levels limit which profiles may run (see 3).

## 10. Instrumentation

Always on. Everything goes in `.review-flow/`, which contains its own `.gitignore` (`*`). The repo's `.gitignore` is never edited.

Each call records: role, step, harness, model, effort, tokens (input, cache read, cache write, output), cost and cost source, wall time, status, and reads outside the worktree that ran. Steps and runs are rolled up from these records.

Each run writes `.review-flow/runs/<timestamp>-<sha>/`:

| File                | Content                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `run.json`          | Resolved config, target, base and head SHAs (and snapshot SHA), trust level, status, per-step and total cost and time |
| `calls.jsonl`       | One record per model call                                                                                             |
| `diff.patch`        | Reviewed diff                                                                                                         |
| `prompts/<task>.md` | Exact prompt per task                                                                                                 |
| `raw/<task>.json`   | Raw harness output                                                                                                    |
| `summary.json`      | Summary (see 7)                                                                                                       |
| `findings.json`     | Findings (see 5)                                                                                                      |
| `pre-existing.json` | Pre-existing findings                                                                                                 |
| `report.md`         | Report                                                                                                                |
| `posted.json`       | What was posted, with comment ids                                                                                     |
| `asks.jsonl`        | Questions and answers from `ask` (see 7)                                                                              |

Each run also appends one summary line to `.review-flow/index.jsonl`: preset, config hash, `REVIEW.md` hash, diff size, finding counts, cost, and time. Eval runs are included and marked as evals. `runs` and `compare` read from it.

## 11. Evaluation

`review-flow eval` runs the current config against a dataset and saves the results as an eval run.

- **Bug cases.** PRs that introduced a bug a later PR fixed, from small public repos (a few MB each, so checkouts stay cheap). The fix tells us where the bug is.
- **Clean cases.** Changes with no real defects, to measure false positives.
- **Checkouts.** One clone per case repo, kept in `~/.cache/review-flow/eval/` and reused across evals. It is outside any project, so agents don't pick up the rules or `AGENTS.md` of the repo running the eval. Each case checks out its head and is reviewed against its base. Cases run one at a time.
- **Scores.** Recall (known bugs found by a finding that wasn't refuted, in the same file with lines overlapping or at most 3 apart), reviewer recall (refuted findings count too, to show verifiers refuting real bugs), findings per clean case (not refuted), and cost and time per case. Failed cases are counted but not scored.
- **Eval run.** A run dir with `run.json` (config, per-step totals summed over cases, scores), `cases.json` (result per case), and `cases/<id>/`, a full run dir per case.
- **Size.** About 35 cases, with a smoke set of about 8 for quick iteration. The dataset, its sources, and its format are in [eval/](eval/README.md).

`compare` shows two evals side by side. Every change to prompts, models, presets, or pipeline values is checked with an eval before it becomes a default.

## 12. Distribution

- One npm package, `review-flow`, with a `review-flow` binary. Use it with `npx review-flow` or install it globally.
- Requires Node 24 or later, `git`, and at least one supported agent CLI. `gh` is needed only for PR targets, trust detection, and posting.
- Internal packages are bundled into the CLI and not published.

## 13. Set by measurement

The spec leaves these values to eval results:

- File-group size for finders, and batch size for verifiers.
- Default harness, model, and effort per role, per preset.
- Default budgets per preset.
- The noise filter list.
- Voting size and threshold in `deep`.
- The pre-flight warning threshold.
