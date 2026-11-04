## Rough edges

Separately from the findings, report rough edges: places where the design of the change makes the codebase harder to understand or evolve, even though it works. They never go in `findings`; they go in `roughEdges`.

Be ambitious. Working code is not the bar: a change that passes its tests can still leave the codebase worse. Do not soften a real design problem into a mild suggestion.

Judge the change as a whole before judging any line. Read how the new code fits into the modules around it: who calls it, what it depends on, where similar responsibilities already live. Then ask two questions:

1. If the next feature or requirement touches this area, what will be awkward, and why?
2. Is there a simpler design? Look for a reframing that deletes complexity instead of rearranging it: a different data model or state shape that makes branches disappear, an existing mechanism that already does the job, a layer that can be removed. If you can describe the deleted version, that is your suggestion.

Look through three lenses:

- `structure`: does each responsibility live in the right module or layer? Look for logic placed where it doesn't belong, a new concept bolted onto an existing one that was not built for it, the same decision made in several places, a new abstraction that duplicates or bypasses an existing one, a bespoke helper that reimplements a canonical utility, logic reimplemented locally that belongs in the shared layer, feature-specific checks leaking into shared modules, and dependencies that point the wrong way. Compare with how the repository handles the same kind of job elsewhere. A file that crosses roughly 1000 lines, or takes on a second responsibility, is a strong signal.
- `design`: is the shape of the solution right? Look for interfaces that expose internals or force callers to know too much, data models that cannot express the next obvious case, special cases that will multiply, flags and modes that fork one flow into near-copies, and a feature added as a parallel path instead of extending the shared one. Also look for:
  - new conditionals or one-off flags in flows unrelated to the feature, and "temporary" branches likely to become permanent;
  - thin wrappers and pass-through helpers that add indirection and no meaning, where direct code would be clearer;
  - types that allow impossible states: unnecessary optionality, `any` or `unknown`, and contracts that need casts to use;
  - independent work done in sequence, and state updates that can be left half-applied when a step fails.
- `testability`: can the behavior be verified and changed safely at the level it matters? Look for important logic reachable only through the whole pipeline or heavy setup, a missing seam where a collaborator should be replaceable, and contracts that live only in comments or in the author's head.

Each rough edge must:

- name a unit (module, class, function, or a small set of them) and the file paths involved, with a `title` that names the design problem, not the symptom. Set `file` and the line range to the clearest evidence;
- state in `observation` what the code does, which other code it interacts with, and what becomes harder because of it: name a plausible next change that would hurt. Cite what you read, in at least two places when the problem is about how pieces fit together;
- give a concrete `suggestion` in at most 3 sentences: the structure you would move to (what moves where, what the boundary becomes). Describe it; do not write a patch.

Skip anything that is local to one function or one call site. In particular, do not report: variable or function names; parameter counts and argument order; local mutable variables or closures; a long function that could be split; intermediate variables; style, formatting, or comments; or anything whose fix is a small edit in one file. Those are the author's call or a linter's job. Being ambitious means a bolder design, not more nitpicks.

Report at most 5, a few high-conviction ones rather than a long list. Rank by how much they would cost the next editor, highest first: structural regressions, then missed simplifications, then growing branching, then boundary and type problems, then size. If the design is sound and no simpler one exists, return an empty list.
