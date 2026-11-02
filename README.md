# review-flow

A local CLI that reviews your code changes with AI agents. One agent summarizes the change, another looks for bugs, separate agents try to refute each finding, and you get a summary and a ranked report with the cost of the run.

> **Preview (0.x).** It reviews the current branch or a GitHub PR. Expect breaking changes.

## Requirements

- Node 24 or later, and `git`.
- One agent CLI, signed in: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) or [Cursor CLI](https://cursor.com/cli) (`agent`).
- For PRs: the [GitHub CLI](https://cli.github.com) (`gh`), signed in.

## Usage

In a git repo, on the branch you want reviewed:

```bash
npx review-flow
```

It reviews the branch against `origin/main` (fetched first), including uncommitted changes. The first run asks which agent CLI to use and remembers it.

| Flag                  | Does                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `-b, --base <ref>`    | Base to diff against (default: `origin/main`, or `master`)                                            |
| `-H, --harness <h>`   | `claude` or `cursor`. Required without a TTY unless one was saved.                                    |
| `--model`, `--effort` | Model and effort for all agents. `--verifier-*` and `--summarizer-*` versions override them per role. |
| `--no-summary`        | Skip the summary of the change                                                                        |
| `--committed-only`    | Review `HEAD` without uncommitted changes                                                             |
| `-q, --quiet`         | Print only the run directory                                                                          |
| `-v, --verbose`       | Print more detail: agent commands, sessions and text, exit codes, tokens per call, step times         |

### Pull requests

```bash
npx review-flow 123          # or a PR URL
```

It fetches the PR, checks out its head in a temporary worktree (your checkout is untouched), and reviews it against the PR's base. PR code is treated as trusted, so only review PRs you trust. In a terminal it then offers to post findings: pick the summary and findings with the arrow keys and Space, preview the review, and confirm. It posts one comment-only review: findings on lines in the diff as inline comments, the rest in the review body, after the summary. `review-flow post [run]` posts a past PR review (default: the latest).

Other commands: `review-flow summary [target]` only summarizes the change, `review-flow runs` lists past runs, and `review-flow compare <a> <b>` compares two runs by cost, time, and findings.

## What it does

1. **Summarize.** In parallel with the review, an agent writes a short summary for you: the goal (from the PR description or commit messages), what changes, how well the goal is met (gaps and extras), and where to look. It's printed before the findings.
2. **Review.** An agent reads the diff and the code around it and reports concrete defects with a failure scenario.
3. **Verify.** A fresh agent per finding tries to refute it by reading the code. It doesn't see the reviewer's reasoning.
4. **Rank.** Confirmed findings first, then inconclusive ones, by severity. Refuted findings are hidden.

Agents are read-only: they can only read, search, and list files in the repo. If anything in the working tree changes during a run, the run stops.

## Output

Each run is saved in `.review-flow/runs/<timestamp>-<sha>/`: the report, summary, findings, exact prompts, and the cost, tokens, and time of every agent call. `.review-flow/` ignores itself, so your `.gitignore` is not touched.

Cost is API-equivalent USD, whatever your plan. A typical run costs $0.30 to $3 and takes 1 to 3 minutes with the default Claude model (Sonnet 5.5).

## Development

The design is in [SPEC.md](SPEC.md), progress in [PROGRESS.md](PROGRESS.md), and the roadmap in [PLAN.md](PLAN.md).

```bash
pnpm install
pnpm review-flow review     # run from source
pnpm check                  # format, lint, typecheck, tests
pnpm install:global         # global copy installed from a packed tarball, as npm would
pnpm uninstall:global       # remove it
pnpm release                # bump, publish to npm, tag, and draft a GitHub release
```

## License

MIT
