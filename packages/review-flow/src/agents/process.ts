import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** After SIGTERM, how long the CLI gets to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 4_000;

export interface CliRunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, so large prompts don't hit argv limits. */
  input: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Each stdout line, parsed as JSON; lines that aren't JSON come as `{ unparsed }`. */
  onMessage: (message: unknown) => void;
  /** Called with a function that stops the CLI, e.g. when a message shows a forbidden action. */
  onStart?: (stop: () => void) => void;
}

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the CLI could not be started. */
  error?: Error;
  timedOut: boolean;
  stderr: string;
}

/**
 * Runs a headless agent CLI that prints one JSON message per line. Timeouts and aborts send
 * SIGTERM, then SIGKILL after a grace period.
 */
export async function runCli(options: CliRunOptions): Promise<CliRun> {
  let stderr = "";
  let timedOut = false;
  const child = spawn(options.bin, options.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  // An abort before the listener was added already fired, so the listener won't see it.
  if (options.signal?.aborted) stop();
  options.onStart?.(stop);

  const exited = new Promise<Omit<CliRun, "timedOut" | "stderr">>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", () => {}); // EPIPE if the CLI exits before reading the prompt.
  child.stdin.end(options.input);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });

  for await (const line of createInterface({ input: child.stdout })) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = { unparsed: line };
    }
    options.onMessage(message);
  }
  const exit = await exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", stop);
  return { ...exit, timedOut, stderr };
}

/** Why a CLI ended without a result, e.g. `agent ended without a result (exit code 3): boom`. */
export function noResultError(bin: string, run: CliRun): string {
  const how = run.signal === null ? `exit code ${run.code}` : `signal ${run.signal}`;
  const detail = run.stderr.trim();
  return `${bin} ended without a result (${how})${detail === "" ? "" : `: ${detail}`}`;
}
