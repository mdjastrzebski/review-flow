# References

Similar tools and useful material. Each entry lists what we can learn from it.

## How the Claude Code team does code review

Anthropic, Oct 2026. <https://claude.dev/blog/solving-code-review-at-anthropic/>

How Anthropic reviews its own code with Claude, using automated layers and human approval based on risk.

Takeaways:

- **Find, then verify.** Parallel agents look for bugs. Separate verifier agents vote on each finding, and only findings with enough agreement get posted.
- **Filter noise.** Style, diagnostic, and cleanup-only findings are dropped. The filters were A/B tested before adoption.
- **Rank and tag.** Findings are sorted by severity and tagged Important, Nit, or Pre-existing, so the author isn't blamed for bugs they inherited.
- **Depth presets.** Each repo is set to Quick, Standard, or Deep. This supports our defaults (principle 1) and configuration (principle 2).
- **Evals from incidents.** PRs that caused past incidents or reverts become an eval set. Every change to prompts, tools, or model is scored against it.
- **Measure noise by developer response.** Each finding is tracked as fixed, rejected, intentional, or ignored. The reviewer also runs on known-clean PRs to catch false positives.
- **Control convergence.** Rounds are capped, later passes re-review only the diff, whole bug classes are flagged instead of single lines, and repeat findings are suppressed. Mean reviews to pass fell from 2.08 to 1.32.
- **Gap:** the article reports no dollar costs or token budgets. Our cost focus (principles 3 and 4) is not covered there.

## agent-browser and agent-device

<https://agent-browser.dev/configuration>, <https://oss.callstack.com/agent-device/docs/configuration>

Agent-facing CLIs (browser and mobile device control) with the same config conventions.

Takeaways:

- **Layered JSON config.** User `~/.<tool>/config.json` < project `./<tool>.json` < `<TOOL>_*` env vars < CLI flags. `--config <path>` or `<TOOL>_CONFIG` loads one file instead.
- **Keys mirror CLI flags** in camelCase, so config and flags share one vocabulary.
- **Schema.** agent-browser publishes a `$schema` for editor autocomplete.
- **Strict validation.** agent-device fails on unknown keys or bad values. We do the same, so a typo in a budget can't silently cost money.
