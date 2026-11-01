# Plan

The order of work toward [SPEC.md](SPEC.md). Measurement comes first, so every later change can be judged by the [principles](contributing/principles.md). Then cost and quality, then configuration, then user features. Numbers in parentheses are spec sections.

## Phase 1: Measurement

Goal: know what a review costs, where the money goes, and how good it is.

- [x] **Headless harness (9).** Replace the Agent SDK with a `claude -p` profile: read-only flags, the guard hook passed with `--settings`, isolated sessions, `--json-schema` output, and usage parsing. Done when: the tests pass and a run on the same diff gives similar findings, with cost and time recorded.
- [x] **Call records (10).** `calls.jsonl` with tokens (input, cache read, cache write, output), cost and cost source, and time per call. Per-step and per-run totals in `run.json`. Done when: `run.json` shows cost and time per step.
- [ ] **Run index (10).** `index.jsonl`, `review-flow runs`, and `review-flow compare`. Done when: `compare` shows per-step cost and time and the finding differences between two runs.
- [ ] **Eval dataset (11).** Check the Greptile and Tenki corpus licenses and pick one. Import 20 to 30 bug cases with a one-off script, add about 10 clean cases (merged PRs with no fix or revert afterward), and mark about 8 cases as the smoke set. Store everything in our own format. Done when: the dataset is in the repo with its source and license noted.
- [ ] **Eval command (11).** `review-flow eval [--smoke]` keeps its own checkout per case repo, runs the pipeline with each case's base and head, and scores recall (same file, overlapping lines, small tolerance), findings per clean case, cost, and time. Results are saved as an eval run. Done when: `compare` works on two eval runs.
- [ ] **Baseline.** Run today's pipeline 3 times on the full set. Done when: the mean and spread are in the decision log.

## Phase 2: Cost and quality

Goal: the same or better quality for less money. Each item follows the acceptance rule below and ends with an entry in the decision log.

- [ ] **Finding model (5).** Origin, `unverified`, severity set by the verifier, and `pre-existing.json`. Scoring ignores pre-existing findings. This changes what is scored, so the baseline is run again (3 times) afterward.
- [ ] **Cheaper verifier.** Try a cheaper model or lower effort for verifiers.
- [ ] **Batched verifiers (4).** Batch findings by file group, send the diff once per batch, and verify the highest severity first.
- [ ] **Dedupe (4).** Merge findings with the same root cause, including bug classes across files.
- [ ] **Filter (4).** Drop style, cleanup-only, and diagnostic findings. Judged mainly on the clean cases.
- [ ] **Finder sharding (4).** Split large diffs into file groups, one finder each.

### Acceptance rule

1. Iterate on the smoke set, then confirm on the full set. Run 3 times when the result is close to the baseline spread.
2. A **cost change** is accepted when recall stays within the baseline spread, findings per clean case don't rise beyond it, and cost or time drops.
3. A **quality change** is accepted when recall or findings per clean case improve beyond the spread. Its extra cost is stated in the log.

## Phase 3: Configuration and defaults

Goal: zero-config reviews that are good by default, with overrides for everything else.

- [ ] **Config files (8).** JSONC user and project files, env vars, flags, `--config`, strict validation, `$schema`, `review-flow config`, and `config set`.
- [ ] **Presets (8).** `quick`, `standard`, and `deep`, with values from phase 2. `deep` adds finder focus areas and verifier voting, each checked with an eval.
- [ ] **Budgets (8).** Money and time limits, the pre-flight estimate, the graceful stop, and the unknown-cost warning.
- [ ] **Exit codes (7).** `failOn` and exit codes `0` to `4` and `130`.
- [ ] **Base detection (2).** Fetch `origin/main` or `master`, prompt in a TTY, and fall back to local.
- [ ] **Default harness (9).** Detect installed CLIs and remove the required `--harness` flag.

## Phase 4: User features

Goal: cover how developers actually review, in order of usefulness.

- [ ] **Worktree (4, 10).** Review in a disposable worktree. `.review-flow/` gets its own `.gitignore`, and the root `.gitignore` is no longer edited.
- [ ] **Targets (2).** Branch, commit, `a..b`, and `a...b` targets, plus uncommitted changes through a snapshot commit.
- [ ] **Distribution (12).** The npm package `review-flow` and `review-flow doctor`.
- [ ] **PR targets and trust (2, 3).** PR number or URL, trust levels and their policies, and `--trust`.
- [ ] **Posting (7).** `review-flow post` with selection, editing, the stale-head check, preview, and a `COMMENT` review.
- [ ] **Review guide (8).** `REVIEW.md`, read from the base for untrusted targets.
- [ ] **Incremental reviews (6).** Interdiff focus, follow-up of earlier findings, repeat suppression, and response records.
- [ ] **More harnesses (9).** `codex` and `cursor` profiles, user-defined profiles, and the price table for computed cost.

## Decision log

Every measured decision, newest first.

| Date       | Change                                                                      | Eval runs                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Decision                                                                                                                |
| ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-11-01 | Diff as cached shared context for verifiers, first verifier warms the cache | 1 run on `040a17c..1dc424e` before and after                   | Verify: $0.68 for 3 verifiers ($0.52, $0.09, $0.08) vs $1.95 for 4 ($0.47–$0.52 each); verifiers 2+ read the 54k-token diff from cache instead of writing it. Warm-up added 6 s; verify wall time 30 s vs 45 s. Run: $0.94 vs $2.70, but the reviewer's drop ($0.26 vs $0.75) came from the previous run's 1-hour cache, not this change. Findings 3 (all confirmed) vs 4; overlap on `~` and brace expansion. Trade-off: the diff now sits in the system prompt, framed as data. | Keep. Re-check verdict quality against the baseline once the eval exists. Eval runs must account for cross-run caching. |
| 2026-11-01 | Agent SDK → `claude -p` harness                                             | 1 run on `040a17c..1dc424e`, against the SDK run of 2026-10-28 | $2.21 / 1.7 min vs $2.95 / 2.2 min. Reviewer cost about the same ($0.71 vs $0.72); verifiers a bit faster. 3 findings vs 4, all in the same area (guard escapes); 1 identical (brace expansion). Single runs, so the difference is within normal run-to-run variance.                                                                                                                                                                                                             | Keep. Re-check against the baseline once the eval exists.                                                               |
