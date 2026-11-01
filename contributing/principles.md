# Principles

Use these to guide the spec, the plan, and design decisions.

## 1. Reasonable defaults

Most users get a good review with zero configuration.

- One command to start, no up-front decisions.
- Defaults (models, steps, budgets) balance quality and cost for a typical change.
- Defaults are based on measurements (principle 4) and revisited as models and prices change.

## 2. Configurable

Users can adjust the review to their needs:

- **Models** per role (reviewer, verifier, ranker, ...).
- **Budgets** for money and time, with predictable behavior when a limit is hit.
- **Steps** to include or skip.

Users override only what they care about; the rest falls back to defaults.

## 3. Cost-effective

Reach the desired review quality at the lowest cost.

- **Primary metric:** money spent per review.
- **Secondary metric:** time per review.
- Quality is the target. Cost and time are optimized without lowering it.
- Every step and model call must improve quality enough to justify its cost. If it doesn't, make it cheaper, optional, or remove it.

## 4. Instrumented

Record where money and time go, so we can find what to optimize.

- Cost and time per run, per step, and per model call.
- Token breakdown: input, cached input, output.
- Always on and cheap.
- Saved so runs can be compared across configs, models, and prompts.

## When principles conflict

1. Quality target first.
2. Money over time.
3. Defaults cover the common case; configuration covers the rest.
4. If unsure, measure before deciding.
