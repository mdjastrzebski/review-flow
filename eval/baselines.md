# Baseline results

Today's pipeline on the baseline set (12 cases: 7 bug, 5 clean), one run per configuration, 2026-11-02, summary on, all roles on the same model. Run dirs are under `.review-flow/runs/` (not committed). Cursor cost is computed from the price table; Cursor runs of Claude models use Cursor's own model ids (`claude-sonnet-5-5-high`; the bracket syntax `[effort=high]` is rejected for them).

| Harness | Model                     | Run                    | Recall | Reviewer recall | Findings per clean case | Cost per case | Time per case | Missed                                                  |
| ------- | ------------------------- | ---------------------- | ------ | --------------- | ----------------------- | ------------- | ------------- | ------------------------------------------------------- |
| claude  | Sonnet 5.5 high (default) | `20261102-142053-eval` | 6/7    | 6/7             | 2.20                    | $0.22         | 47 s          | typer-1128                                              |
| claude  | Opus 5.5 medium           | `20261102-174542-eval` | 5/7    | 6/7             | 1.60                    | $0.36         | 49 s          | typer-1128; h3-1372 found, then refuted by the verifier |
| cursor  | Grok 4.7 low (default)    | `20261102-142102-eval` | 6/7    | 6/7             | 2.00                    | $0.63         | 4 m 14 s      | typer-1128                                              |
| cursor  | Composer 2.5              | `20261102-153141-eval` | 5/7    | 5/7             | 1.80                    | $0.26         | 2 m 47 s      | typer-1128, h3-1372                                     |
| cursor  | Sonnet 5.5 high           | `20261102-174643-eval` | 6/7    | 6/7             | 2.40                    | $0.33         | 1 m 14 s      | typer-1128                                              |

Reading them:

- Every configuration missed typer-1128; it is a hard case, not a model difference.
- One bug case is 14 points of recall, so differences of one case are within the spread. The clean-case counts (5 cases) are just as coarse.
- Sonnet 5.5 high on `claude` is the cheapest of the full-recall runs and the fastest per dollar; the same model on Cursor costs 1.5× as much and takes 1.6× as long.
- Opus medium costs 1.6× Sonnet high with no recall gain; its verifier refuted the h3-1372 bug the reviewer had found.
- Runs of different harnesses ran at the same time; parallel runs inflate time slightly and share no cache across cases.

## Cost and time by step

Totals over the 12 cases. Time is summed agent time per step (cases run one at a time); the last column is wall time of the whole eval.

| Run                    | Summarize | Review | Verify (calls) | Total cost | Summarize time | Review time | Verify time | Wall     |
| ---------------------- | --------- | ------ | -------------- | ---------- | -------------- | ----------- | ----------- | -------- |
| claude Sonnet 5.5 high | $0.31     | $0.66  | $1.62 (25)     | $2.59      | 1.3 min        | 3.9 min     | 5.5 min     | 9.4 min  |
| claude Opus 5.5 medium | $0.94     | $1.30  | $2.14 (24)     | $4.38      | 3.4 min        | 5.2 min     | 4.6 min     | 9.8 min  |
| cursor Grok 4.7 low    | $0.73     | $3.89  | $2.90 (22)     | $7.52      | 5.0 min        | 35.7 min    | 15.0 min    | 50.8 min |
| cursor Composer 2.5    | $0.39     | $1.71  | $1.05 (19)     | $3.15      | 5.5 min        | 21.7 min    | 11.7 min    | 33.4 min |
| cursor Sonnet 5.5 high | $0.71     | $1.09  | $2.12 (34)     | $3.92      | 3.2 min        | 6.6 min     | 8.1 min     | 14.8 min |

## Per case

`F` bug found, `M` missed, `R` found by the reviewer but refuted by the verifier; a number is findings on a clean case.

| Case            | Kind  | claude Sonnet | claude Opus med | cursor Grok low | cursor Composer | cursor Sonnet |
| --------------- | ----- | ------------- | --------------- | --------------- | --------------- | ------------- |
| chi-986         | clean | 2             | 2               | 3               | 3               | 2             |
| click-2829      | bug   | F             | F               | F               | F               | F             |
| cobra-1559      | clean | 2             | 1               | 2               | 1               | 3             |
| execa-199       | bug   | F             | F               | F               | F               | F             |
| h3-1372         | bug   | F             | R               | F               | M               | F             |
| hono-5133       | bug   | F             | F               | F               | F               | F             |
| requests-6154   | clean | 5             | 4               | 3               | 2               | 5             |
| starlette-3143  | clean | 0             | 0               | 0               | 1               | 0             |
| typer-1128      | bug   | M             | M               | M               | M               | M             |
| urfave-cli-2245 | bug   | F             | F               | F               | F               | F             |
| werkzeug-1540   | bug   | F             | F               | F               | F               | F             |
| werkzeug-3163   | clean | 2             | 1               | 2               | 2               | 2             |

## Full set

Claude Sonnet 5.5 high (default), all 35 cases (25 bug, 10 clean), `20261102-183402-eval`, 2026-11-02.

| Recall      | Reviewer recall | Findings per clean case | Cost per case | Time per case | Failed cases |
| ----------- | --------------- | ----------------------- | ------------- | ------------- | ------------ |
| 22/25 (88%) | 23/25 (92%)     | 1.40 (14 in 10)         | $0.24         | 48 s          | 0/35         |

- Missed: starlette-3410, typer-1128. hono-5205 was found by the reviewer, then refuted by the verifier.
- Plan usage (Team): the run took the 5-hour limit from 22% to 48% and the weekly limit from 50% to 54%.

## Rescored with the judge

The tables above match findings to bugs by location only. The same runs, judged again with `review-flow rescore` (judge: Claude Sonnet 5.5 high, the same for every run, 2026-11-02). Judging costs about $0.13 to $0.15 per baseline eval and $0.54 for the full set, and is not in the costs above.

| Run                              | Recall (judged) | Reviewer recall (judged) | Recall by location | Changed by the judge                                            |
| -------------------------------- | --------------- | ------------------------ | ------------------ | --------------------------------------------------------------- |
| claude Sonnet 5.5 high           | 5/7 (71%)       | 5/7                      | 6/7                | execa-199 found → missed                                        |
| claude Opus 5.5 medium           | 4/7 (57%)       | 4/7                      | 5/7                | execa-199 found → missed; h3-1372 refuted → missed              |
| cursor Grok 4.7 low              | 4/7 (57%)       | 4/7                      | 6/7                | execa-199 and h3-1372 found → missed                            |
| cursor Composer 2.5              | 4/7 (57%)       | 4/7                      | 5/7                | execa-199 found → missed                                        |
| cursor Sonnet 5.5 high           | 5/7 (71%)       | 5/7                      | 6/7                | execa-199 and h3-1372 found → missed; typer-1128 missed → found |
| claude Sonnet 5.5 high, full set | 20/25 (80%)     | 21/25                    | 22/25 (88%)        | execa-199 and requests-6655 found → missed                      |

- Findings per clean case and cost don't depend on matching and are unchanged.
- By location alone, every run looked 1 to 2 bugs better. Several "found" bugs were findings that only covered the bug's lines (execa-199 in all six runs).
- The judge credited one catch the location match missed: cursor Sonnet found typer-1128's real bug (the missing `rich.markup` import) at another line.
- The judge says execa-199 was never found, in all six runs, which is consistent but rests on a one-line bug description ("Child process errors should reject the promise right away"). The fix PR (execa#270) hasn't been read to check that the judge isn't too strict.
- Judging is one call per case by one model; the same bug could flip with another judge. Compare runs only when they were judged by the same one.

## Judge against location scoring

Checked on the stored findings of the six rescored evals (no new reviews): 60 judged bug results.

|                    | Count |
| ------------------ | ----- |
| Both found the bug | 41    |
| Both missed it     | 9     |
| Location only      | 9     |
| Judge only         | 1     |

They agree on 50 of 60 (83%). The 10 disagreements are 4 distinct bugs; each was read against its fix PR's diff:

| Bug           | Disagreements                                      | Reading                                                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typer-1128    | judge found, location missed (cursor Sonnet)       | Judge right. The fix (typer#1290) changes `core.py` (`rich.markup.escape` → `rich_utils.escape_before_html_export`); the dataset's locations (`main.py`) are blame-based and don't include it. The finding named the missing `rich.markup` import.                                        |
| requests-6655 | location found, judge missed (full set)            | Judge right. The fix (requests#6716) adds an override hook for pool key attributes; the credited findings were a directory-CA bug, `verify=None`, and a return annotation.                                                                                                                |
| execa-199     | location found, judge missed (all 6 runs)          | Unclear, leaning judge. The fix (execa#270) makes child errors and timeouts reject; the credited finding was about partial output on timeout, which the fix doesn't change. A second finding (the early-exit race only installed if the timer is pending) is on the code the fix removes. |
| h3-1372       | location found, judge missed (Grok, cursor Sonnet) | Grok: defensible (numeric statuses crashing, which the fix's `sanitize.ts` change also touches, not the string-throw bug). Cursor Sonnet: judge wrong. Its F-001, a sync `throw 404` returning 200, is the `handler.ts` change the fix makes.                                             |

Also wrong: the Opus run's h3-1372 (confirmed finding that a sync number throw returns 200; the judge matched nothing, and location had only a refuted hit). So the judge has false negatives on h3-1372, where it matched a string-throw finding in one run and missed the number-throw finding in two. Cells where both scorers say "missed" can hide the same kind of error.

Next, without new reviews: judge each eval twice more to measure how often it flips; give the judge the fix's diff (the description alone is one line); and hand-label the disputed cases as a small gold set.

## Judge checks

- **Stability.** Each of the six evals was judged three times with the same setup: 59 of 60 bug results were identical in all three passes; only typer-1018 (full set) flipped (found, missed, found). The judge is consistent, so its errors repeat: the h3-1372 misses above were stable.
- **Fix diff.** Judging again with the fix PR's diff shown to the judge (`rescore-fix.json` in each eval dir) changed three results, all h3-1372 missed → found, and each is the sync `throw 404` finding that matches the fix's `handler.ts` change: Opus medium, Composer, and cursor Sonnet. The other 57 results didn't change; execa-199 stays missed in all six runs, which supports the judge's reading of it. Grok's h3-1372 stays missed (its finding was about numeric statuses crashing, not the string-throw bug).

Judged recall with the fix diff, which `eval` and `rescore` now use by default:

| Run                              | Recall      | Reviewer recall | Recall by location |
| -------------------------------- | ----------- | --------------- | ------------------ |
| claude Sonnet 5.5 high           | 5/7 (71%)   | 5/7             | 6/7                |
| claude Opus 5.5 medium           | 5/7 (71%)   | 5/7             | 5/7                |
| cursor Grok 4.7 low              | 4/7 (57%)   | 4/7             | 6/7                |
| cursor Composer 2.5              | 5/7 (71%)   | 5/7             | 5/7                |
| cursor Sonnet 5.5 high           | 6/7 (86%)   | 6/7             | 6/7                |
| claude Sonnet 5.5 high, full set | 20/25 (80%) | 21/25           | 22/25 (88%)        |

With the judge, the runs sit within one bug of each other on the baseline set, so differences between models there are within the spread. Judge cost with fix diffs: $0.14 to $0.17 per baseline eval, $0.59 for the full set. The hand-labelled gold set is not built.
