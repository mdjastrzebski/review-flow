import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

export interface RunDir {
  readonly root: string;
  readonly diffPath: string;
  readonly runJsonPath: string;
  readonly callsPath: string;
  readonly findingsPath: string;
  readonly verdictsPath: string;
  readonly reportPath: string;
  readonly postedPath: string;
  promptPath(taskId: string): string;
  rawPath(taskId: string): string;
}

export function runDirPaths(root: string): RunDir {
  return {
    root,
    diffPath: path.join(root, "diff.patch"),
    runJsonPath: path.join(root, "run.json"),
    callsPath: path.join(root, "calls.jsonl"),
    findingsPath: path.join(root, "findings.json"),
    verdictsPath: path.join(root, "verdicts.json"),
    reportPath: path.join(root, "report.md"),
    postedPath: path.join(root, "posted.json"),
    promptPath: (taskId) => path.join(root, "prompts", `${taskId}.md`),
    rawPath: (taskId) => path.join(root, "raw", `${taskId}.json`),
  };
}

/** Creates `.review-flow/runs/<yyyymmdd-hhmmss>-<shortsha>/` with its prompts/ and raw/ subdirs. */
export async function createRunDir(repo: string, shortSha: string, now: Date): Promise<RunDir> {
  const runsDir = path.join(repo, STATE_DIR, "runs");
  await mkdir(runsDir, { recursive: true });
  return createRunDirAt(path.join(runsDir, `${formatRunTimestamp(now)}-${shortSha}`));
}

/** Creates a run dir at `root`, whose parent must exist, with its prompts/ and raw/ subdirs. */
export async function createRunDirAt(root: string): Promise<RunDir> {
  // Non-recursive so two runs in the same second fail loudly instead of sharing a directory.
  await mkdir(root);
  await mkdir(path.join(root, "prompts"));
  await mkdir(path.join(root, "raw"));
  return runDirPaths(root);
}
