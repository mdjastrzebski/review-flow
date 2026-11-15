import { mkdir } from "node:fs/promises";
import path from "node:path";

/** The files every run dir has; a domain layer adds its own artifacts by name. */
export interface RunDirBase {
  readonly root: string;
  readonly runJsonPath: string;
  readonly callsPath: string;
  promptPath(taskId: string): string;
  rawPath(taskId: string): string;
  /** An artifact in the run dir, such as `findings.json`. */
  path(name: string): string;
}

export function runDirBase(root: string): RunDirBase {
  return {
    root,
    runJsonPath: path.join(root, "run.json"),
    callsPath: path.join(root, "calls.jsonl"),
    promptPath: (taskId) => path.join(root, "prompts", `${taskId}.md`),
    rawPath: (taskId) => path.join(root, "raw", `${taskId}.json`),
    path: (name) => path.join(root, name),
  };
}

/** Creates a run dir at `root`, whose parent must exist, with its prompts/ and raw/ subdirs. */
export async function createRunDirAt(root: string): Promise<RunDirBase> {
  // Non-recursive so two runs in the same second fail loudly instead of sharing a directory.
  await mkdir(root);
  await mkdir(path.join(root, "prompts"));
  await mkdir(path.join(root, "raw"));
  return runDirBase(root);
}
