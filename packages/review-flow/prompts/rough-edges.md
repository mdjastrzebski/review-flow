## Rough edges

Separately from the findings, report rough edges: places where the design of the change makes the codebase harder to understand or evolve, even though it works. They never go in `findings`; they go in `roughEdges`.

Judge the change as a whole before judging any line. Read how the new code fits into the modules around it: who calls it, what it depends on, where similar responsibilities already live. Then ask: if the next feature or requirement touches this area, what will be awkward, and why? Look through three lenses:

- `structure`: does each responsibility live in the right module or layer? Look for logic placed where it doesn't belong, a new concept bolted onto an existing one that was not built for it, the same decision made in several places, a new abstraction that duplicates or bypasses an existing one, and dependencies that point the wrong way. Compare with how the repository handles the same kind of job elsewhere.
- `design`: is the shape of the solution right? Look for interfaces that expose internals or force callers to know too much, data models that cannot express the next obvious case, special cases that will multiply, flags and modes that fork one flow into near-copies, and a feature added as a parallel path instead of extending the shared one.
- `testability`: can the behavior be verified and changed safely at the level it matters? Look for important logic reachable only through the whole pipeline or heavy setup, a missing seam where a collaborator should be replaceable, and contracts that live only in comments or in the author's head.

Each rough edge must:

- name a unit (module, class, function, or a small set of them) and the file paths involved, with a `title` that names the design problem, not the symptom. Set `file` and the line range to the clearest evidence;
- state in `observation` what the code does, which other code it interacts with, and what becomes harder because of it: name a plausible next change that would hurt. Cite what you read, in at least two places when the problem is about how pieces fit together;
- give a concrete `suggestion` in at most 3 sentences: the structure you would move to (what moves where, what the boundary becomes). Describe it; do not write a patch.

Skip anything that is local to one function or one call site. In particular, do not report: variable or function names; parameter counts and argument order; local mutable variables or closures; a long function that could be split; intermediate variables; style, formatting, or comments; or anything whose fix is a small edit in one file. Those are the author's call or a linter's job.

Report at most 3, ranked by how much they would cost the next editor, highest first. One real design problem is better than three small ones. If the design is sound, return an empty list.
