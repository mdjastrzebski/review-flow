# Eval dataset

35 cases from 19 small open-source repos: 25 bug cases and 10 clean cases. Three nested sets, set by each case's `preset` (the smallest set it belongs to): the **smoke** set (5 cases), the **baseline** set (12 cases, including smoke, the default), and **full** (all 35). Used by `review-flow eval` (spec 11):

```bash
pnpm review-flow eval --harness claude           # the baseline set, 12 cases
pnpm review-flow eval --harness claude --full    # all 35
pnpm review-flow eval --harness claude --smoke   # 5 cases, a quick end-to-end check
pnpm review-flow eval --harness claude --rough-edges  # also score rough edges, apart from findings, with a rubric judge
pnpm review-flow eval --harness claude --rough-edges --edge-judge-harness cursor  # judge them with another model family
```

For a quick check that the eval runs end to end (too few cases to judge quality), pick a few small cases and a cheap model:

```bash
pnpm review-flow eval --harness claude --case click-2829 h3-1372 werkzeug-3163 --model claude-haiku-5-5 --effort low
```

These are among the smallest cases: two bugs (Python, TypeScript) and one clean case.

## Source

Mined from GitHub on 2026-11-01 with [scripts/mine.ts](scripts/mine.ts), then picked by hand.

- **Bug cases.** A merged fix PR names the PR that introduced the bug ("regression introduced by #N"). The introducing PR is the case. The bug's location is found by blaming the lines the fix changed back to that PR (the SZZ method) and mapping them to the PR's head. One location was set by hand where the fix only added code (see `LOCATION_OVERRIDES` in the script).
- **Clean cases.** Merged PRs from 2022 to April 2026 that change at least 20 code lines and at most 400 lines in total, where no later fix-like commit (fix, bug, revert, regression) changes lines the PR wrote. This doesn't prove they have no bugs, only that none were found and fixed.
- **Smoke set.** The 5 smallest cases for a quick end-to-end check: 3 bugs and 2 clean, in Python, TypeScript, and Go (click-2829, h3-1372, urfave-cli-2245, werkzeug-3163, chi-986).
- **Baseline set.** 12 cases across Python, TypeScript, and Go, 7 with bugs and 5 clean. The 8 original cases are small diffs; 4 larger ones were added (execa-199, cobra-1559, requests-6154, starlette-3143), mostly clean cases so findings per clean case averages over more than 2.

Picking rules: the fix is a real bug fix (not docs, CI, typing, or performance), the case changes at most about 430 lines, and at most 3 bug cases come from one repo.

Martian's code review benchmark (Greptile's 50 PRs, MIT) was considered first and dropped: its repos (Sentry, Grafana, Keycloak, cal.com, Discourse) are 0.5 to 1.6 GB each, and its bugs have no file or line locations.

## License

The dataset stores only references: repo URLs, commit SHAs, PR links, fix PR titles, and line numbers. No source code is copied. All 19 repos use permissive licenses: MIT, BSD-3-Clause (pallets, encode, Kludex/starlette), or Apache-2.0 (psf/requests, spf13/cobra).

## Format

One JSON file per case in [cases/](cases/):

```json
{
  "id": "starlette-3410",
  "kind": "bug",
  "preset": "full",
  "title": "Offload large GZip compression",
  "repo": "https://github.com/Kludex/starlette",
  "pr": "https://github.com/Kludex/starlette/pull/3410",
  "base": "5567e274…",
  "head": "cb824a1c…",
  "diff": { "files": 3, "additions": 92, "deletions": 9 },
  "bugs": [
    {
      "description": "Default `thread_minimum_size` in `GZipResponder`",
      "fix": "https://github.com/Kludex/starlette/pull/3415",
      "locations": [{ "file": "starlette/middleware/gzip.py", "start": 156, "end": 156 }]
    }
  ]
}
```

- `base` and `head` are commits on the repo's default branch. Review `base..head`.
- `preset` is `smoke`, `baseline`, or `full`: the smallest eval set that includes the case (`--smoke`, the default, `--full`).
- `kind` is `bug` or `clean`. Clean cases have no `bugs`.
- `locations` use line numbers in the `head` version, inclusive. A finding that overlaps any location of a bug counts as finding it.
- `description` is the fix PR's title; `fix` links to the full story.

## Size

- Diffs: 3,481 changed lines in total, at most 426 per case. The baseline set has 905.
- Full clones of all 19 repos: about 220 MB, 2 to 27 MB each.

## Baseline results

Scores of today's pipeline on the baseline set, per harness and model: [baselines.md](baselines.md).
