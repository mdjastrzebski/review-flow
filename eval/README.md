# Eval dataset

35 cases from 19 small open-source repos: 25 bug cases and 10 clean cases. 8 of them are marked `smoke`. Used by `review-flow eval` (spec 11).

## Source

Mined from GitHub on 2026-11-01 with [scripts/mine.ts](scripts/mine.ts), then picked by hand.

- **Bug cases.** A merged fix PR names the PR that introduced the bug ("regression introduced by #N"). The introducing PR is the case. The bug's location is found by blaming the lines the fix changed back to that PR (the SZZ method) and mapping them to the PR's head. One location was set by hand where the fix only added code (see `LOCATION_OVERRIDES` in the script).
- **Clean cases.** Merged PRs from 2022 to April 2026 that change at least 20 code lines and at most 400 lines in total, where no later fix-like commit (fix, bug, revert, regression) changes lines the PR wrote. This doesn't prove they have no bugs, only that none were found and fixed.
- **Smoke set.** Small diffs across Python, TypeScript, and Go: 6 bug cases and 2 clean cases.

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
  "smoke": false,
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
- `kind` is `bug` or `clean`. Clean cases have no `bugs`.
- `locations` use line numbers in the `head` version, inclusive. A finding that overlaps any location of a bug counts as finding it.
- `description` is the fix PR's title; `fix` links to the full story.

## Size

- Diffs: 3,481 changed lines in total, at most 426 per case. The smoke set has 326.
- Full clones of all 19 repos: about 220 MB, 2 to 27 MB each.
