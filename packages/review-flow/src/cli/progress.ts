import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import { formatElapsed, type Summary, type TaskActivity, type TrustLevel } from "../core/index.ts";
import { formatSummaryFields } from "./format.ts";

/** Where review and eval report progress. Call `end` before printing results. */
export interface Progress {
  log(message: string): void;
  warn(message: string): void;
  logTable(title: string, rows: readonly (readonly [string, string])[]): void;
  /** Set only for the live display; without it the pipeline logs each activity as a line. */
  onActivity?: (activity: TaskActivity) => void;
  /** Set only for the live display, which shows the summary when it's ready. */
  onSummary?: (summary: Summary, trust: TrustLevel) => void;
  end(): void;
}

const silent: Progress = { log() {}, warn() {}, logTable() {}, end() {} };

/**
 * Progress on stdout. In a terminal: clack lines with a spinner showing the latest agent
 * activity, and paths under `cwd` shortened. Otherwise plain lines, one per event. `--verbose`
 * keeps every activity line, so it uses the plain activity lines inside the clack frame.
 */
export function createProgress(options: {
  quiet: boolean;
  verbose: boolean;
  cwd: string;
}): Progress {
  if (options.quiet) return silent;
  const output = process.stdout;
  if (!output.isTTY) {
    return {
      log: (m) => console.log(m),
      warn: (m) => console.log(m),
      logTable: (_, rows) => {
        for (const [label, value] of rows) console.log(`${label}: ${value}`);
      },
      end() {},
    };
  }

  const short = (message: string) => message.replaceAll(`${options.cwd}/`, "");
  let opened = false;
  const open = () => {
    if (!opened) clack.intro("review-flow", { output });
    opened = true;
  };

  const running = new Map<string, TaskActivity>();
  let status = "";
  let spinner: ReturnType<typeof clack.spinner> | null = null;
  const startSpinner = () => {
    open();
    // Draw the guide bar ourselves so it can be erased again when the spinner stops;
    // otherwise each restart would leave a stray bar behind.
    output.write(`${styleText("gray", "│")}\n`);
    spinner = clack.spinner({ output, withGuide: false });
    spinner.start(status);
  };
  const stopSpinner = () => {
    if (spinner === null) return;
    spinner.clear();
    spinner = null;
    output.write("\x1b[1A\x1b[2K\r");
  };
  /** Prints a line above the spinner. */
  const print = (write: () => void) => {
    const spinning = spinner !== null;
    stopSpinner();
    open();
    write();
    if (spinning) startSpinner();
  };

  const onActivity = (activity: TaskActivity) => {
    if (activity.done) running.delete(activity.taskId);
    else running.set(activity.taskId, activity);
    // Between tasks nothing is running, but the pipeline is: keep the spinner so the
    // display never looks idle.
    const latest = activity.done ? [...running.values()].at(-1) : activity;
    const line = latest
      ? `${latest.taskId} ${formatElapsed(latest.elapsedMs)}${running.size > 1 ? ` (+${running.size - 1} more)` : ""}  ${short(latest.text)}`
      : "Working…";
    // Room for the spinner frame, its dots, and the cursor.
    const width = (output.columns ?? 80) - 8;
    status = line.length > width ? `${line.slice(0, width - 1)}…` : line;
    if (spinner === null) startSpinner();
    else spinner.message(status);
  };

  return {
    log: (message) => print(() => clack.log.step(short(message), { output })),
    warn: (message) => print(() => clack.log.warn(short(message), { output })),
    logTable: (title, rows) => {
      const width = Math.max(...rows.map(([label]) => label.length));
      const lines = rows.map(([label, value]) => `${label.padEnd(width)}  ${short(value)}`);
      print(() => clack.note(lines.join("\n"), title, { output }));
    },
    ...(options.verbose ? {} : { onActivity }),
    onSummary: (summary, trust) => {
      // The box adds a border and padding on each side.
      const width = Math.min(output.columns ?? 100, 100) - 6;
      const fields = formatSummaryFields(summary, trust, {
        color: output.hasColors?.() ?? false,
        width,
      });
      print(() => clack.note(short(fields), "Summary", { output }));
    },
    end() {
      stopSpinner();
      running.clear();
      if (opened) clack.outro("", { output });
      opened = false;
    },
  };
}
