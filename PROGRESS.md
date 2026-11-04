# Progress

What is implemented so far. The target design is [SPEC.md](SPEC.md).

## Status

A working CLI that reviews a branch or a GitHub PR with agents run through a headless CLI, `claude -p` or Cursor's `agent -p`: a summarizer describes the change, one reviewer finds issues in parallel, verifiers check each finding, and the result is a summary and a ranked report.

```bash
npx review-flow                                        # published package; asks for harness and base
pnpm review-flow review                                # from source; or -H claude -b main
pnpm review-flow 123                                   # a PR, by number or URL
pnpm review-flow summary                               # summary only, no findings
pnpm review-flow post                                  # post findings of the latest PR review
pnpm review-flow ask                                   # questions about the latest run, also while it runs
pnpm review-flow eval --harness claude                     # score the baseline set (--smoke, --full)
pnpm review-flow runs                                  # past runs and evals, newest first
pnpm review-flow compare <a> <b>                       # two runs or two evals side by side
```

## Harnesses

Both spawn the CLI per task, with the prompt on stdin, and read its `stream-json` output line by line ([process.ts](packages/review-flow/src/agents/process.ts)). Timeouts and Ctrl-C send SIGTERM, then SIGKILL after 5 s. With `--verbose`, each task also prints its command line (long arguments cut short), the session's id and model, the agent's text, refused tool calls, how the CLI exited with its stderr, and its tokens, time, and cost source; the run prints repo, base and head SHAs, diff size, and step times.

### claude

`claude -p --output-format stream-json` per task ([claude.ts](packages/review-flow/src/agents/claude.ts)). The prompt goes on stdin, the output schema with `--json-schema`. Shared context (the diff, for verifiers) goes in a file appended to the system prompt with `--append-system-prompt-file`, because the system prompt is cached as its own block and later sessions can read it; a shared prefix inside the user message is not reused. Tool calls in the stream drive the progress lines. The final `result` message gives the structured output, cost (`total_cost_usd`), and tokens. The binary is set with `--claude-bin` (default `claude`).

### cursor

`agent -p --output-format stream-json --mode ask --sandbox enabled --trust` per task ([cursor.ts](packages/review-flow/src/agents/cursor.ts)). Cursor has no schema flag or system prompt flag, so the prompt is the shared context, then the task, then the output JSON Schema. The answer is the last JSON object in the result text that fits the schema; if none does, one repair turn resumes the same session (`--resume`) and asks for corrected JSON only. Effort goes in the model id (`claude-opus-5-5[effort=high]`). The `result` message gives tokens but no cost, so cost is computed from the [price table](packages/review-flow/src/core/prices.ts). The binary is set with `--cursor-bin` (default `agent`).

## Progress output

In a terminal, `review` and `eval` draw progress with [@clack/prompts](https://github.com/bombshell-dev/clack/tree/main/packages/prompts) ([progress.ts](packages/review-flow/src/cli/progress.ts)). Labelled facts go in boxes: the PR (title, base, head), the review setup (harness, models, uncommitted files, checkout, run dir, and the `ask` command to copy into another terminal, with the same launcher: `npx review-flow`, `pnpm review-flow`, or `review-flow`), the eval setup (models, cases, dataset, run dir), the summary as soon as the summarizer finishes (so it isn't printed again after the run), and the files saved at the end. Step milestones are one line each. Agent tool calls update a single spinner line (the latest task, its time, and how many others are running) instead of piling up. Paths under the current directory are shortened. With `--verbose`, every agent line is kept, and the repo, base, head, diff size, and step times join the boxes. Without a terminal, every event is a plain line, as before. Prompts draw on stderr, progress on stdout.

## Pipeline

`collect → (summarize ‖ review → normalize → verify → rank) → report` ([pipeline.ts](packages/review-flow/src/core/pipeline.ts))

1. **Collect.** Diff `base...HEAD` (three-dot). Uncommitted changes (staged, unstaged, and untracked, respecting `.gitignore`) are included through a snapshot commit on top of `HEAD`, built with a temporary index so the developer's index is untouched; `--committed-only` skips them, and `eval` always does. The CLI prints how many uncommitted files are included, and the prompts say the change is "`HEAD` plus uncommitted changes". Exit cleanly if there are no changes.
2. **Summarize.** One agent session, started next to the reviewer ([summarizer.md](packages/review-flow/prompts/summarizer.md), [summary.ts](packages/review-flow/src/core/summary.ts)). It gets the diff as the same shared context as the verifiers, plus the PR title and description or the branch's commit messages (`base..HEAD`), fenced, capped at 8,000 chars, and framed as the author's untrusted text. It returns `summary.json`: the goal (`stated` or `inferred`), 3–6 behavior changes, whether the goal is met (`yes`, `mostly`, `partly`, `unclear`) with gaps and extras, and 1–3 places to look; lists over the cap are cut. A failed summarizer leaves the run without a summary and the report says so; a thrown error (such as a changed working tree) aborts the reviewer and verifiers too, and the other way round. `--no-summary` skips it.
3. **Review.** One agent session gets the full diff and read-only repo access, and returns findings as structured JSON ([reviewer.md](packages/review-flow/prompts/reviewer.md)). It is told to report only concrete defects with a failure scenario, at most 15.
   The same session also returns up to 5 **rough edges** ([rough-edges.md](packages/review-flow/prompts/rough-edges.md)): places in the new code that work but are harder to follow or change, through three lenses (readability, structure, testability). They are not defects: no severity, not counted with the findings, and not in exit codes or eval scores. Evals run with them off (the prompt says to return an empty list).
4. **Normalize.** Cap at 15 findings, assign ids (`F-001`…), make paths repo-relative, fix reversed line ranges.
5. **Verify.** One fresh agent session per finding, up to 3 in parallel ([verifier.md](packages/review-flow/prompts/verifier.md)). The verifier tries to refute the claim and returns `confirmed`, `refuted`, or `inconclusive`, plus severity, confidence, fix cost, evidence, and an assessment of the suggested fix. To avoid anchoring, it doesn't see the reviewer's rationale, severity, or category. The diff is shared context ([change.md](packages/review-flow/prompts/change.md)), framed as data, not instructions. The first verifier runs alone until its first tool call, so its request has cached the diff before the others start.
   After the verifiers, one batched checker session on the verifier's model ([rough-edge-checker.md](packages/review-flow/prompts/rough-edge-checker.md), [rough-edges.ts](packages/review-flow/src/core/rough-edges.ts)) marks each rough edge `accurate`, `inaccurate`, or `unclear`; a failed or incomplete answer leaves it `unclear`. All are saved to `rough-edges.json` with their check; the report, terminal output, and `post` leave out the `inaccurate` ones.
6. **Rank.** Rules enforced in code: `confirmed` without a `code_ref` is downgraded to `inconclusive`, and a failed verifier counts as `inconclusive`. Findings are sorted by verdict, then severity, then confidence ([rank.ts](packages/review-flow/src/core/rank.ts)).
7. **Report.** Markdown report plus terminal output, both with the summary before the findings. Refuted findings come last, apart: a collapsed section in the report, a "Refuted" section in the terminal with no severity and only the verifier's reason. The terminal's finding count leaves them out.

`review-flow summary [target]` runs only Collect, Summarize, and Report, with the same targets, base, and flags as `review`. Its run is saved and indexed like any other, without findings; a failed summarizer fails it.

## Pull requests

`review-flow <number or URL>` ([github.ts](packages/review-flow/src/core/github.ts), [worktree.ts](packages/review-flow/src/core/worktree.ts)):

1. **Fetch.** `gh pr view` gives the PR's base branch, head SHA, and repo. The git remote pointing at that repo (`origin` on a tie) is fetched: the base into `<remote>/<base>`, the head into `FETCH_HEAD` only, so no ref is added.
2. **Worktree.** A detached worktree at the head, with hooks off, under `.review-flow/worktrees/<pid>-<sha>/`. Agents work there; the run dir and index stay in the main repo. The worktree is removed when the run ends, also on failure or Ctrl-C. Worktrees whose process is gone are removed at the start of the next PR review.
3. **Review.** The usual pipeline, against `<remote>/<base>`. `run.json` records the PR, and its index line the PR number. `--base` is refused.
4. **Post.** In a TTY, offered after the review when there is something to post; or later with `review-flow post [run]` (default: the latest PR review) ([post.ts](packages/review-flow/src/core/post.ts), [cli/post.ts](packages/review-flow/src/cli/post.ts)). A checkbox list ([@clack/prompts](https://github.com/bombshell-dev/clack/tree/main/packages/prompts); arrow keys move, Space marks, Enter accepts) shows the summary first, then every finding that wasn't refuted, then the rough edges (never pre-selected, labelled in the comment as `Rough edge (lens)`); the summary and confirmed findings of medium severity or higher are pre-selected, and the summary can be posted alone. If the PR head moved since the run, it warns and asks before posting on the reviewed commit. It previews the review, asks to confirm, and sends one `COMMENT` review with `gh api`. A finding whose lines are all in the diff becomes a multi-line inline comment; one partly in the diff is anchored to its first diff line; the rest go in the review body, after the summary (when selected) and the finding counts, with a footer. A comment shows the title, severity, claim, and fix (the verifier's better fix when it found the suggested one flawed or incomplete). `posted.json` records the review and comment ids; if reading the comments back fails, it is still written, without comment ids, and a warning is printed. Posting a run again asks first.

## Questions

`review-flow ask [run] [question]` answers follow-up questions about a run, by default the latest one, running or not; with several running, a TTY asks which, and without one it fails ([ask.ts](packages/review-flow/src/core/ask.ts), [cli/ask.ts](packages/review-flow/src/cli/ask.ts)). The review's own terminal never takes questions: its setup box shows the command to run in another terminal.

1. **Start.** Prints the run's summary, waiting while the summarizer runs (or saying it failed or was skipped), then the findings' state (pending, verification pending, counts, or the run failed) and the checkout's path.
2. **Checkout.** No fetch, `gh` call, or new checkout from the network. A current-branch run uses the developer's checkout, with a warning when `HEAD` or the uncommitted changes differ from what was reviewed. A PR run uses the run's worktree under a lease (`leases/<pid>` in the run dir, holding the worktree's path). A review that ends, and stale-worktree cleanup, leave a leased worktree in place; the last `ask` out, after the review has ended, removes it. If the worktree is gone, `ask` adds `.review-flow/worktrees/ask-<run id>` at the reviewed commit from local objects; if that commit is gone too, it fails with exit `3`.
3. **Questions.** A TTY loop (an empty line or Ctrl-C ends it), or one question given as an argument (a single argument with a space is the question). Each question is one headless call with role `answerer` and the run's harness and verifier model (`-H`, `--model`, `--effort` override them), the same read-only flags, guard hook, and `git status` check as the review ([answerer.md](packages/review-flow/prompts/answerer.md)). The diff is the shared context, as for verifiers; the prompt has the author's description, the summary, and the answering rules, then the findings with verdicts (fenced as data), up to 20,000 chars of earlier questions and answers, and the question. The parts that change between questions come last, so the stable start of the prompt can be cached. Findings are read again before each question; when they changed, a line with their counts comes before the answer. Each answer prints its cost and time, and the loop prints the session total.
4. **Records.** Each question goes to `asks.jsonl` and its call to `calls.jsonl` with step `ask`. `run.json` and the index are never touched, so review totals, `compare`, and `eval` leave ask cost out.
5. **`--open`.** Hands the terminal to the harness's interactive CLI in the checkout, holding the lease until it exits: `claude` with the same tools, guard hook, and isolation flags, and the diff plus the answerer's instructions appended to the system prompt; `agent --mode ask --sandbox enabled` with that context as its first message and an empty config dir. Its cost is recorded as `unknown`.

Errors exit with code `3`.

## Trust levels

Each target gets a trust level ([trust.ts](packages/review-flow/src/core/trust.ts)), shown in the review setup and saved in `run.json` with its reason:

- `own`: the current checkout.
- `collaborator`: a same-repo PR (`isCrossRepository == false`). Eval cases count as `collaborator` too: merged PRs of public repos.
- `external`: a fork PR.

`--trust <level>` replaces the detected level; the reason keeps what was detected. What the level changes:

- **Pre-flight.** For an `external` target in a TTY, the diff size and a cost estimate are shown before any agent runs, and the review goes on only on a yes. The estimate is the cost range of the 5 past completed runs in the index, with the same harness and steps and a full cost, closest in changed lines. Declining leaves no run dir. Without a terminal, it warns and goes on. The facts and prompt go to stderr, so `--quiet` shows them too.
- **Harness.** Each harness has an enforcement level; `claude` and `cursor` are both `enforced`. A `best-effort` one would be allowed for `own`, warned about for `collaborator`, and refused for `external` without `--allow-unenforced`.
- **Summary.** A stated goal of an `external` target is marked "as stated by the author", in the terminal, the report, and a posted review.

## Safety

- `claude` agents only get `Read`, `Grep`, and `Glob` (`--tools`, `--allowed-tools`, `--permission-mode dontAsk`). A `PreToolUse` command hook, passed with `--settings`, also denies any other tool and any path outside the repo, following symlinks and expanding a leading `~` as Claude Code does, and fails closed ([guard.ts](packages/review-flow/src/agents/guard.ts), [guard-hook.ts](packages/review-flow/src/agents/guard-hook.ts)).
- `cursor` agents run in ask mode (read-only) with the sandbox on, which refuses shell, writes, MCP, and web fetches. Cursor has no pre-tool hook and still allows reads outside the repo, so each tool call is checked once it completes. A forbidden call Cursor refused is recorded as denied. A read outside the repo that ran is recorded in `outsideReads` in `calls.jsonl` and printed, and the task goes on. Any other forbidden call that ran stops the task with an error. Each Cursor task gets its own empty config dir (`CURSOR_CONFIG_DIR`), so the user's CLI settings (such as a shell allowlist) don't apply and chats aren't saved with theirs. Cursor sessions still see project rules and `AGENTS.md`. Blocking outside reads up front isn't possible: a `Read(...)` deny rule stops the read tool, but deny beats allow (so the repo can't be re-allowed under a deny-all), and glob and grep ignore read rules.
- `claude` sessions are isolated: `--setting-sources ""` (no user or project settings, CLAUDE.md, or AGENTS.md), auto-memory off, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`.
- `git status` is snapshotted before the run and checked after every task. Any change aborts the run.

## Run output

Each run writes `.review-flow/runs/<timestamp>-<sha>/`. `.review-flow/` holds its own `.gitignore` (`*`), so the repo's `.gitignore` is never edited.

| File                | Content                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `diff.patch`        | Reviewed diff                                                                                                                                                                                    |
| `prompts/<task>.md` | Exact prompt per task                                                                                                                                                                            |
| `raw/<task>.json`   | CLI args, all stream messages, stderr tail, denied tool calls                                                                                                                                    |
| `calls.jsonl`       | One line per agent task: role, step, model, effort, status, tokens, cost and cost source, start, duration, reads outside the repo that ran                                                       |
| `summary.json`      | Summary of the change (when the summarizer succeeded)                                                                                                                                            |
| `findings.json`     | Normalized findings                                                                                                                                                                              |
| `verdicts.json`     | Verdict per finding                                                                                                                                                                              |
| `report.md`         | Ranked report                                                                                                                                                                                    |
| `posted.json`       | Posted review: id, URL, commit, and comment id per finding (PR reviews that were posted)                                                                                                         |
| `intent.json`       | PR title and description, or the branch's commit messages, for `ask`                                                                                                                             |
| `asks.jsonl`        | One line per `ask` question (or `--open` session): question, answer, status, cost, time, findings' state                                                                                         |
| `leases/<pid>`      | One per running `ask` that holds the run's worktree                                                                                                                                              |
| `run.json`          | Models, base/head SHAs (plus `head.snapshotSha` when uncommitted changes were reviewed), trust level, checkout, steps started, status, and per-step and total calls, cost, tokens, and wall time |

`run.json` is first written when the run dir is made, with status `running` and the reviewing pid, so `ask` can find the run; a `running` run whose pid is gone counts as stopped. It is written again when the run ends. Steps in `run.json` are `collect`, `summarize`, `review` (including normalize), `verify` (including the verdict rules), `check` (the rough-edge checker; only when there are rough edges), and `report`. Step time is wall time, so `verify` is less than the sum of its parallel calls, and `summarize` overlaps `review` and `verify`. A call's cost source is `reported` when the CLI gave a cost, `computed` when its tokens and model are in the price table (standard API prices for Claude 5.5 models, Grok 4.7, and Composer 2.5; fast variants and long-context surcharges are not priced), else `unknown`; `unknownCostCalls` counts them, and when above 0 the cost is a lower bound. `calls.jsonl` is appended as each call ends, so a failed run keeps its records.

Each run, including a failed one, also appends a summary line to `.review-flow/index.jsonl` ([run-index.ts](packages/review-flow/src/core/run-index.ts)): id (the run dir name), status, harness, models, base and head, diff size (files, added and removed lines), finding count, verdict counts, cost, unknown-cost calls, and time. Eval runs add one line each, with `kind: "eval"`, the case count, and the scores; their case runs aren't indexed.

## Runs and compare

- `review-flow runs [-n <count>]` lists indexed runs and evals, newest first (default 20). A cost of `≥$x` means some calls had no cost. Eval rows show the case count and recall in place of the diff and findings.
- `review-flow compare <a> <b>` takes a run id, a unique part of one (such as the short SHA), or a run dir path, from the current dir or from `.review-flow/runs/` ([compare.ts](packages/review-flow/src/core/compare.ts), [runs.ts](packages/review-flow/src/cli/runs.ts)). Both must be review runs or both evals. It shows the models and diff of each run, cost, time, and calls per step with deltas, and the findings in both runs and in only one. Findings match when they are in the same file and their line ranges are at most 3 lines apart, closest pairs first. When the runs reviewed different commits, it warns that line matching is rough.

## Eval

`review-flow eval [--smoke | --full]` reviews every case of the [dataset](eval/README.md) with the same harness and model flags as `review` ([eval.ts](packages/review-flow/src/core/eval.ts), [eval-score.ts](packages/review-flow/src/core/eval-score.ts)).

- **Selection.** The baseline set (12 cases) by default, `--smoke` for the smoke set (5), `--full` for all 35, or `--case <ids...>` for chosen ones (from all cases unless `--smoke` or `--full` is also given, which then limits them). [eval/README.md](eval/README.md) has a 3-case recipe for a quick end-to-end check.
- **Checkouts.** One clone per case repo in `~/.cache/review-flow/eval/` (`--checkouts`), cloned on first use and fetched when a case's commit is missing. Each case checks out its head (detached, forced, `git clean -ffdx`) and is reviewed against its base. Cases run one at a time, in id order.
- **Scoring.** After each bug case, a **judge** agent ([judge.md](packages/review-flow/prompts/judge.md), [eval-judge.ts](packages/review-flow/src/core/eval-judge.ts)) gets the fix's title, the bug's location, the fix PR's diff (fetched with `gh`, cached in `~/.cache/review-flow/eval-fixes`, capped at 12,000 chars; `--no-fix-diff` leaves it out), and all findings (claim and a capped rationale, as data), and reads `diff.patch` in the case's run dir. It names the findings that describe the same defect, wherever they point (`judge.json`). A bug is found when a matched finding wasn't refuted; reviewer recall counts refuted ones too. The judge uses the run's verifier model; `--judge-model` and `--judge-effort` override it, `--no-judge` scores by location alone (same file, lines overlapping or at most 3 apart). Judged bugs keep their by-location result, so the output shows "Recall by location only", and the judge's cost is reported apart from the run's cost. A failed judge call falls back to location for that case, with a warning. A failed case (clone, checkout, or reviewer failure) is counted but not scored. An agent changing a checkout stops the eval.
- **Rescore.** `review-flow rescore <eval>` judges a finished eval again from the findings and verdicts in its case run dirs, with no checkout and no reviewer run, four cases at a time. The eval's own files stay as they were; the result goes in `rescore.json`. Use the same judge model to compare evals of different harnesses.
- **Eval run.** `.review-flow/runs/<timestamp>-eval/` in the repo the eval is run from (`--repo`): `run.json` (harness, models, dataset, status, scores, per-step totals summed over cases, total wall time including clones), `cases.json` (outcome, finding counts, matched finding ids, cost, and time per case; rewritten after each case), and `cases/<id>/`, a normal run dir per case. Case run dirs live there, not in the checkout, so the checkout's `.gitignore` and index stay untouched.
- **Output.** Progress per case, then a table of case outcomes (`found`, `refuted`, `missed`, `N findings`, `failed`) and the scores: recall, reviewer recall, findings per clean case, failed cases, and cost and time per case. `--quiet` prints only the eval run dir.
- **Compare.** Two evals show their scores and per-step totals with deltas, the cases whose outcome changed, and a warning when they ran different cases. To see one case's findings in two evals: `compare <eval a>/cases/<id> <eval b>/cases/<id>`.

## Configuration

CLI flags, plus `harness` in `~/.review-flow/config.json`: `-b, --base`, `-H, --harness`, `--model` (every role unless overridden), `--verifier-model`, `--summarizer-model`, `--effort` (likewise), `--verifier-effort`, `--summarizer-effort`, `--no-summary`, `--claude-bin`, `--cursor-bin`, `--committed-only`, `--trust`, `--allow-unenforced`, `--repo`, `--quiet`, `--verbose`. Without `--base`, `review` fetches `main` (or `master`) from origin and uses `origin/main`, asking to confirm it in a TTY; with no origin or a failed fetch it uses local `main` and warns that it may be stale. Without `--harness`, `review` and `eval` use the saved `harness`; if none is saved, a TTY run asks with an arrow-key list (default `claude`) and saves the answer, and a non-TTY run fails. `eval` takes the same, minus `--base`, `--committed-only`, `--trust`, and `--allow-unenforced`, plus `--smoke`, `--full`, `--case`, `--dataset`, `--checkouts`, `--no-judge`, `--judge-model`, and `--judge-effort`. `rescore <eval>` takes the agent flags, `--judge-model`, `--judge-effort`, `--dataset`, `--repo`, `--quiet`, and `--verbose`. `summary` takes the same flags as `review`, minus `--no-summary`.

Defaults ([models.ts](packages/review-flow/src/core/models.ts)):

- `claude`: Sonnet 5.5 at `high` effort for the reviewer and verifiers, and at `medium` for the summarizer. It matched Opus 5.5 on quality at about half the cost (see the [decision log](PLAN.md#decision-log)).
- `cursor`: `grok-4.7-low` for every role. Composer 2.5 was cheaper but missed a high-severity bug; Grok 4.7 medium and high were slow and read outside the repo (see the [decision log](PLAN.md#decision-log)). A `--model` override passes no effort unless `--effort` is given, because not every Cursor model accepts one.

Hard-coded: timeouts (reviewer 20 min, verifier and summarizer 10 min), verifier concurrency (3), max findings (15), suggested-fix cap (10 lines / 800 chars).

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
- **Summary:** about $0.02 and 5–8 s per review on the baseline set, about 10% of the cost. It runs while the reviewer works, so it adds no time (see the [decision log](PLAN.md#decision-log)).
- **Questions:** $0.06–0.08 and 13–29 s each on a small PR (typer#1128), the first and follow-ups alike (see the [decision log](PLAN.md#decision-log)).
- **Repeat runs on the same diff are cheaper**: the reviewer prompt stays in the 1-hour cache, so a second run within the hour skipped a $0.50 cache write. Compare first runs with first runs.

## Distribution

All CLI code is one package, [packages/review-flow](packages/review-flow), published to npm as `review-flow`, with `src/core` (pipeline, eval, runs), `src/agents` (harnesses and the guard), and `src/cli`. The workspace stays for future packages such as eval tooling. `pnpm build` compiles `src/` to `dist/` with `tsc`. Runtime files are found by relative paths that are the same from `src/` and `dist/`: `prompts/` and `package.json` at the package root, and the guard hook (`.ts` from source, `.js` once built, since Node won't strip types inside `node_modules`). The eval dataset isn't published, so an installed `eval` needs `--dataset`. `prepack` builds and copies in the root README and LICENSE. `pnpm release` runs release-it: checks, version bump, `pnpm publish`, commit, tag, push, and a GitHub release draft opened in the browser.

## Gaps against the [spec](SPEC.md)

- **Usage (2):** `--harness` (or a saved one) is required without a TTY; installed CLIs aren't detected. No branch, commit, or range targets. No `config` or `doctor` commands.
- **Trust (3):** only the current checkout and PRs are classified, since there are no branch or commit targets yet. No `trust` rules in config. `REVIEW.md` and repo config don't exist yet, so nothing is read from the base. No `best-effort` harness exists, so `--allow-unenforced` has no effect yet. Branch reviews run in the developer's checkout, not a worktree.
- **Pipeline (4):** one finder, no dedupe or filter, one verifier session per finding with the full diff each time.
- **Finding model (5):** no origin, no `unverified`. Pre-existing bugs are not reported.
- **Incremental reviews (6) and exit codes (7):** none.
- **Summary (7):** the line below the summary has finding counts only: no files not read, unverified findings, or budget hits, since those don't exist yet.
- **Posting (7):** no editing in `$EDITOR`. Posted findings aren't used for repeat suppression yet.
- **Questions (7):** the answerer has no `roles` config yet, only flags. `ask --open` hasn't been tried live; Cursor's version passes the whole context as an argument, so a very large diff may hit argv limits.
- **Configuration (8):** CLI flags and the saved `harness` only. No other config keys, no JSONC or project files, presets, budgets, or `REVIEW.md`.
- **Harnesses (9):** `claude` and `cursor` profiles, hard-coded. No `codex` profile or user profiles. The price table is small and can't be overridden.
- **Instrumentation (10):** the index has no preset, config hash, or `REVIEW.md` hash, since none of those exist yet. Runs from before the index aren't listed by `runs`, though `compare` still takes their ids if their `run.json` has per-step records. The report and terminal summary don't mark totals with `unknown` calls as partial.
- **Evaluation (11):** the dataset and `eval` command exist; no baseline yet. Cases run one at a time, so the full set takes about an hour and the baseline set about 10 minutes. Two evals at once must use different `--checkouts`.
- **Distribution (12):** no `doctor` command.
