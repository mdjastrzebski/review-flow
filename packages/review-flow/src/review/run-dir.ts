import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRunDirAt, runDirBase, type RunDirBase } from "../runtime/run-dir.ts";

export const STATE_DIR = ".review-flow";

/**
 * Creates `.review-flow/` with its own `.gitignore` (`*`), so git ignores it without the repo's
 * .gitignore being edited. Must run before the git status snapshot.
 */
export async function ensureStateDir(repo: string): Promise<void> {
  const dir = path.join(repo, STATE_DIR);
  await mkdir(dir, { recursive: true });
  // "wx" leaves an existing file alone.
  await writeFile(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `yyyymmdd-hhmmss` in local time. */
export function formatRunTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** A review run's artifacts, by file name; flows write them with `ctx.write`. */
export const RUN_FILES = {
  diff: "diff.patch",
  summary: "summary.json",
  findings: "findings.json",
  verdicts: "verdicts.json",
  roughEdges: "rough-edges.json",
  report: "report.md",
  posted: "posted.json",
  intent: "intent.json",
  asks: "asks.jsonl",
} as const;

export interface RunDir extends RunDirBase {
  readonly diffPath: string;
  readonly summaryPath: string;
  readonly findingsPath: string;
  readonly verdictsPath: string;
  readonly roughEdgesPath: string;
  readonly reportPath: string;
  readonly postedPath: string;
  /** The PR description or commit messages, for `ask`. */
  readonly intentPath: string;
  readonly asksPath: string;
  /** One file per running `ask` that holds the run's worktree, named by its pid. */
  readonly leasesDir: string;
}

export function runDirPaths(root: string): RunDir {
  const base = runDirBase(root);
  return {
    ...base,
    diffPath: base.path(RUN_FILES.diff),
    summaryPath: base.path(RUN_FILES.summary),
    findingsPath: base.path(RUN_FILES.findings),
    verdictsPath: base.path(RUN_FILES.verdicts),
    roughEdgesPath: base.path(RUN_FILES.roughEdges),
    reportPath: base.path(RUN_FILES.report),
    postedPath: base.path(RUN_FILES.posted),
    intentPath: base.path(RUN_FILES.intent),
    asksPath: base.path(RUN_FILES.asks),
    leasesDir: base.path("leases"),
  };
}

/** Creates `.review-flow/runs/<yyyymmdd-hhmmss>-<shortsha>/` with its prompts/ and raw/ subdirs. */
export async function createRunDir(repo: string, shortSha: string, now: Date): Promise<RunDir> {
  const runsDir = path.join(repo, STATE_DIR, "runs");
  await mkdir(runsDir, { recursive: true });
  const root = path.join(runsDir, `${formatRunTimestamp(now)}-${shortSha}`);
  await createRunDirAt(root);
  return runDirPaths(root);
}
