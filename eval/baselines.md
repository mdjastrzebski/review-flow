# Baseline results

Today's pipeline on the baseline set (12 cases: 7 bug, 5 clean), one run per configuration, 2026-11-02, summary on, all roles on the same model. Run dirs are under `.review-flow/runs/` (not committed). Cursor cost is computed from the price table; Cursor runs of Claude models use Cursor's own model ids (`claude-sonnet-5-5-high`; the bracket syntax `[effort=high]` is rejected for them).

| Harness | Model | Run | Recall | Reviewer recall | Findings per clean case | Cost per case | Time per case | Missed |
| ------- | ----- | --- | ------ | --------------- | ----------------------- | ------------- | ------------- | ------ |
| claude | Sonnet 5.5 high (default) | `20261102-142053-eval` | 6/7 | 6/7 | 2.20 | $0.22 | 47 s | typer-1128 |
| claude | Opus 5.5 medium | `20261102-174542-eval` | 5/7 | 6/7 | 1.60 | $0.36 | 49 s | typer-1128; h3-1372 found, then refuted by the verifier |
| cursor | Grok 4.7 low (default) | `20261102-142102-eval` | 6/7 | 6/7 | 2.00 | $0.63 | 4 m 14 s | typer-1128 |
| cursor | Composer 2.5 | `20261102-153141-eval` | 5/7 | 5/7 | 1.80 | $0.26 | 2 m 47 s | typer-1128, h3-1372 |
| cursor | Sonnet 5.5 high | `20261102-174643-eval` | 6/7 | 6/7 | 2.40 | $0.33 | 1 m 14 s | typer-1128 |

Reading them:

- Every configuration missed typer-1128; it is a hard case, not a model difference.
- One bug case is 14 points of recall, so differences of one case are within the spread. The clean-case counts (5 cases) are just as coarse.
- Sonnet 5.5 high on `claude` is the cheapest of the full-recall runs and the fastest per dollar; the same model on Cursor costs 1.5× as much and takes 1.6× as long.
- Opus medium costs 1.6× Sonnet high with no recall gain; its verifier refuted the h3-1372 bug the reviewer had found.
- Runs of different harnesses ran at the same time; parallel runs inflate time slightly and share no cache across cases.

## Cost and time by step

Totals over the 12 cases. Time is summed agent time per step (cases run one at a time); the last column is wall time of the whole eval.

| Run | Summarize | Review | Verify (calls) | Total cost | Summarize time | Review time | Verify time | Wall |
| --- | --------- | ------ | -------------- | ---------- | -------------- | ----------- | ----------- | ---- |
| claude Sonnet 5.5 high | $0.31 | $0.66 | $1.62 (25) | $2.59 | 1.3 min | 3.9 min | 5.5 min | 9.4 min |
| claude Opus 5.5 medium | $0.94 | $1.30 | $2.14 (24) | $4.38 | 3.4 min | 5.2 min | 4.6 min | 9.8 min |
| cursor Grok 4.7 low | $0.73 | $3.89 | $2.90 (22) | $7.52 | 5.0 min | 35.7 min | 15.0 min | 50.8 min |
| cursor Composer 2.5 | $0.39 | $1.71 | $1.05 (19) | $3.15 | 5.5 min | 21.7 min | 11.7 min | 33.4 min |
| cursor Sonnet 5.5 high | $0.71 | $1.09 | $2.12 (34) | $3.92 | 3.2 min | 6.6 min | 8.1 min | 14.8 min |

## Per case

`F` bug found, `M` missed, `R` found by the reviewer but refuted by the verifier; a number is findings on a clean case.

| Case | Kind | claude Sonnet | claude Opus med | cursor Grok low | cursor Composer | cursor Sonnet |
| ---- | ---- | ------------- | --------------- | --------------- | --------------- | ------------- |
| chi-986 | clean | 2 | 2 | 3 | 3 | 2 |
| click-2829 | bug | F | F | F | F | F |
| cobra-1559 | clean | 2 | 1 | 2 | 1 | 3 |
| execa-199 | bug | F | F | F | F | F |
| h3-1372 | bug | F | R | F | M | F |
| hono-5133 | bug | F | F | F | F | F |
| requests-6154 | clean | 5 | 4 | 3 | 2 | 5 |
| starlette-3143 | clean | 0 | 0 | 0 | 1 | 0 |
| typer-1128 | bug | M | M | M | M | M |
| urfave-cli-2245 | bug | F | F | F | F | F |
| werkzeug-1540 | bug | F | F | F | F | F |
| werkzeug-3163 | clean | 2 | 1 | 2 | 2 | 2 |
