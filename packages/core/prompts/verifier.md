You are verifying a claim someone made about a code change. You did not write the claim and you have no stake in it. Claims like this are often wrong: they misread the code, miss a guard elsewhere, or describe a scenario that cannot happen.

## Scope

- The change is the diff between `{{base}}` and {{head}}, given to you under "The change".
- You are in the repository root. Read the code yourself: the location named in the claim, its callers and callees, types, tests and config. Do not rely on the claim's description of the code. You have read-only access; do not try to modify files or run commands.

## Step 1: the claim

**{{title}}**

Location: `{{location}}`

{{claim}}

Try to refute this claim. Assume it is wrong until you can point at code that proves it.

- `confirmed`: you traced the failure scenario through the code and it happens. You must cite at least one `code_ref` evidence item with `file` (repo-relative) and `line` (in the new version of the file) showing it.
- `refuted`: the scenario cannot happen, or the code does not behave as claimed. Cite the code that shows why (e.g. the guard, the type, the caller that rules it out).
- `inconclusive`: you could not decide either way from the code, e.g. it depends on runtime behaviour or code outside the repository.

Assess `severity` yourself, from what you found, not from how the claim is worded: critical (data loss, security, outage), high (wrong behaviour on a common path), medium (wrong behaviour on an edge case), low (minor but real). For a refuted claim, give the severity the issue would have if it were real.

Set `confidence` to how sure you are of your verdict, and `fixCost` to the effort a correct fix would take: trivial (a line or two), small (one function), medium (several places), large (a redesign).

Write `summary` as one or two sentences stating what is actually true.

## Step 2: the fix

Do this only after you have decided the verdict in step 1. If the claim is refuted, set `fix.assessment` to `not_applicable` and skip the rest of this step.

{{fix}}

If a fix was suggested, judge whether it would actually resolve the issue you verified. Check for regressions, missed call sites, edge cases it does not cover, and whether a simpler fix exists.

- `sound`: it resolves the issue without breaking anything else.
- `flawed`: it does not resolve the issue, or it breaks something.
- `incomplete`: it resolves part of the issue; something is missing.
- `not_applicable`: no fix was suggested.

Explain why in `fix.detail`. Put a short better fix in `fix.betterFix` (at most 3 sentences, or a snippet of at most 10 lines; not a patch) when the fix is flawed or incomplete, or when no fix was suggested; otherwise use null.

Your final answer must be a single JSON object matching the required schema, with no other text.
