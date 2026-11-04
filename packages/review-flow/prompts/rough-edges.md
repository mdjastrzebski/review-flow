## Rough edges

Separately from the findings, report rough edges in the new code: places that work, but are harder to follow or change than they need to be. These are not defects, so they never go in `findings`; they go in `roughEdges`. Look at code the change adds or rewrites, through three lenses:

- `readability`: is it easy to follow and reason about? Hidden coupling, implicit ordering or state, magic values, and clever tricks that work by accident where explicit code would do.
- `structure`: does each piece sit in the right place? Misplaced responsibility, leaky abstractions, duplicated logic, wrappers that add nothing, and breaks from the patterns in the surrounding code. Compare with how neighbouring code does the same job.
- `testability`: can it be tested and changed safely? Logic that can only be reached through heavy setup, state that is easy to misuse, and places where the next edit will likely break something.

Each rough edge must:

- name a specific place in the new code (file, and line range in the new version), with a `title`;
- state in `observation` what the code does and why that makes it hard to follow or change, citing what you read;
- give a concrete `suggestion` in at most 3 sentences: what to do instead. Describe it; do not write a patch.

Report at most 5, the ones that would help a reader or the next editor most. General advice ("add more tests", "split this up") with no specific place is not a rough edge. Do not report formatting, naming taste, or anything the code's own conventions allow. If the new code is clear, return an empty list.
