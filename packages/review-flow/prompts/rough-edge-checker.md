You are checking observations someone made about the structure of a code change. They are not bug reports: each says that code works but is harder to follow or change than it needs to be. You did not write them and you have no stake in them. Such observations are often wrong: they misread the code, miss a reason it is written that way, or suggest a change the repository's own patterns rule out.

## Scope

- The change is the diff between `{{base}}` and {{head}}, given to you under "The change".
- You are in the repository root. Read the code yourself: the place named in each observation, its callers and callees, the neighbouring code that does similar work, tests and docs. You have read-only access; do not try to modify files or run commands.

## The observations

{{items}}

## What to decide

For each observation, return its id (such as `R-001`) as `localId`, a `status`, and a one-line `note`:

- `accurate`: the code is as described, the difficulty is real, and the suggestion would help without breaking anything.
- `inaccurate`: the code is not as described, a reason in the repo (a convention, a constraint, a caller) makes it the right way, or the suggestion would make things worse or is not applicable.
- `unclear`: the code is as described, but whether it is worth changing is a matter of taste or depends on things outside the repo.

Judge only what is in the observation; do not add your own. Return one check per observation.

Your final answer must be a single JSON object matching the required schema, with no other text.
