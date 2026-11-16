/**
 * Paths of a review's flow-tree nodes below its root, as saved in run.json. Flows are named by
 * their function, so renaming one renames its path: read nodes by these, not by repeated strings.
 * review.test.ts checks them against a real run.
 */
export const REVIEW_PATH = {
  collect: "collect",
  summarize: "summarize",
  find: "find",
  review: "find/review",
  verify: "find/verify",
  check: "find/check",
  report: "report",
} as const;
