import * as clack from "@clack/prompts";
import path from "node:path";
import { styleText } from "node:util";
import { getAgent, openInteractive } from "../agents/index.ts";
import {
  HARNESS_ENFORCEMENT,
  buildOpenContext,
  checkHarnessTrust,
  createAskSession,
  describeFindings,
  formatCost,
  formatDuration,
  isRunning,
  listReviewRuns,
  loadAnswererInput,
  loadAskRun,
  openCheckout,
  prTrust,
  readFindings,
  recordOpen,
  resolveAnswerer,
  resolveRepoRoot,
  resolveRun,
  waitForSummary,
  type AskCheckout,
  type AskRun,
  type Effort,
  type Harness,
  type ModelChoice,
  type RunAgent,
  type Trust,
} from "../core/index.ts";
import { formatSummary } from "./format.ts";
import { choose, interactive, note } from "./prompt.ts";

export interface AskOptions {
  repo: string;
  harness?: Harness;
  model?: string;
  effort?: Effort;
  claudeBin: string;
  cursorBin: string;
  open: boolean;
  verbose: boolean;
}

const color = () => process.stdout.hasColors?.() ?? false;
const paint = (style: Parameters<typeof styleText>[0], text: string) =>
  color() ? styleText(style, text, { validateStream: false }) : text;

/** The run to ask about: `ref`, else the latest run, asking which when several are running. */
async function pickRun(repo: string, ref: string | undefined, cwd: string): Promise<AskRun> {
  if (ref !== undefined) return loadAskRun((await resolveRun(repo, ref, cwd)).root);
  const runs = await listReviewRuns(repo);
  if (runs.length === 0) throw new Error("No runs to ask about. Run a review first.");
  const running = runs.filter((r) => isRunning(r.run));
  if (running.length <= 1) return runs.at(-1)!;
  if (!interactive()) {
    throw new Error(
      `${running.length} reviews are running; name one: ${running.map((r) => r.id).join(", ")}`,
    );
  }
  const id = await choose(
    "Which running review?",
    running.map((r) => r.id),
    running.at(-1)!.id,
  );
  if (id === null) throw new Error("No run chosen.");
  return running.find((r) => r.id === id)!;
}

function runTrust(ask: AskRun): Trust {
  const { run } = ask;
  return (
    run.trust ??
    (run.pr === undefined ? { level: "own", reason: "current checkout" } : prTrust(run.pr))
  );
}

/** The summary (waiting for it while the summarizer runs), the findings' state, and the checkout. */
async function printHeader(ask: AskRun, checkout: AskCheckout, cwd: string): Promise<void> {
  const width = Math.min(process.stdout.columns ?? 100, 100);
  let summary = await Promise.race([
    waitForSummary(ask),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 200)),
  ]);
  if (summary === "waiting") {
    const spinner = clack.spinner({ output: process.stderr, withGuide: false });
    spinner.start("Waiting for the summarizer…");
    try {
      summary = await waitForSummary(ask);
    } finally {
      spinner.clear();
    }
  }
  console.log(
    summary === null
      ? `\n${paint("bold", "Summary")}\n  None: the run skipped it.`
      : formatSummary(summary, runTrust(ask).level, { color: color(), width }),
  );
  const { state } = await readFindings(ask.paths);
  const shown = (dir: string) => (dir.startsWith(`${cwd}/`) ? path.relative(cwd, dir) : dir);
  console.log(`\n${paint("dim", "Findings")}  ${describeFindings(state)}`);
  console.log(`${paint("dim", "Checkout")}  ${shown(checkout.dir)}`);
  if (checkout.drift !== null) {
    note.warn(`${checkout.drift} Answers describe the files as they are now.`);
  }
}

export interface LoopAgent {
  harness: Harness;
  model: ModelChoice;
  runAgent: RunAgent;
}

/**
 * Answers `question`, or asks in a loop until an empty line or Ctrl-C/Ctrl-D. Prints each answer
 * with its cost and time, and the session total at the end.
 */
export async function askLoop(
  ask: AskRun,
  checkout: AskCheckout,
  agent: LoopAgent,
  options: { question?: string; verbose: boolean },
): Promise<void> {
  const spinner = clack.spinner({ output: process.stderr, withGuide: false });
  let spinning = false;
  const session = await createAskSession({
    ask,
    checkout,
    ...agent,
    log: (message) => (spinning ? spinner.message(message) : console.error(message)),
    onActivity: (activity) => {
      if (!activity.done && spinning && !options.verbose)
        spinner.message(`Answering… ${activity.text}`);
    },
    verbose: options.verbose,
  });
  let count = 0;
  let costUsd = 0;
  let unknownCost = false;
  let durationMs = 0;

  const answer = async (question: string) => {
    // A spinner only in a terminal; --verbose prints every agent line instead.
    if (!options.verbose && process.stderr.isTTY) {
      spinner.start("Answering…");
      spinning = true;
    }
    let outcome;
    try {
      outcome = await session.ask(question);
    } finally {
      if (spinning) spinner.clear();
      spinning = false;
    }
    count++;
    if (outcome.costUsd === null) unknownCost = true;
    else costUsd += outcome.costUsd;
    durationMs += outcome.durationMs;
    if (outcome.findingsChanged !== null) {
      console.log(`${paint("dim", "Findings")}  ${describeFindings(outcome.findingsChanged)}\n`);
    }
    if (outcome.answer === null) note.warn(`No answer: ${outcome.error}`);
    else console.log(`${outcome.answer}\n`);
    const cost = outcome.costUsd === null ? "cost unknown" : formatCost(outcome.costUsd);
    console.log(paint("dim", `${cost} · ${formatDuration(outcome.durationMs)}\n`));
  };

  if (options.question !== undefined) {
    await answer(options.question);
    return;
  }
  for (;;) {
    const question = await clack.text({
      message: "Question",
      placeholder: "empty line to finish",
      output: process.stderr,
    });
    if (clack.isCancel(question) || question === undefined || question.trim() === "") break;
    console.log();
    await answer(question.trim());
  }
  if (count > 0) {
    const total = `${unknownCost ? "≥ " : ""}${formatCost(costUsd)}`;
    console.log(paint("dim", `${count} question(s): ${total} · ${formatDuration(durationMs)}`));
  }
}

/** The answerer's harness and model: the run's verifier, unless overridden. */
function answerer(ask: AskRun, options: AskOptions): LoopAgent & { harness: Harness } {
  const harness = options.harness ?? ask.run.harness;
  return {
    harness,
    model: resolveAnswerer(harness, ask.run, {
      model: options.model ?? null,
      effort: options.effort ?? null,
    }),
    runAgent: getAgent(harness, { claudeBin: options.claudeBin, cursorBin: options.cursorBin }),
  };
}

/** `review-flow ask [run] [question]`. */
export async function askCommand(
  ref: string | undefined,
  question: string | undefined,
  options: AskOptions,
  cwd: string,
): Promise<void> {
  // `ask "<question>"`: run ids and paths have no spaces, so one argument with a space is a question.
  if (question === undefined && ref !== undefined && /\s/.test(ref)) {
    question = ref;
    ref = undefined;
  }
  const repo = await resolveRepoRoot(options.repo);
  const ask = await pickRun(repo, ref, cwd);
  const agent = answerer(ask, options);
  const warning = checkHarnessTrust(
    agent.harness,
    HARNESS_ENFORCEMENT[agent.harness],
    runTrust(ask),
    false,
  );
  if (warning !== null) note.warn(warning);
  if (question === undefined && !options.open && !interactive()) {
    throw new Error("No terminal to ask in: pass the question as an argument.");
  }

  const checkout = await openCheckout(repo, ask);
  // Ctrl-C outside a prompt: drop the lease, and remove the worktree if this was the last user.
  // With --open, the child CLI gets Ctrl-C instead.
  const onSigint = () => {
    checkout.releaseSync();
    process.exit(130);
  };
  if (!options.open) process.once("SIGINT", onSigint);
  try {
    await printHeader(ask, checkout, cwd);
    if (options.open) {
      await openSession(ask, checkout, agent, options);
      return;
    }
    console.log();
    await askLoop(ask, checkout, agent, {
      ...(question === undefined ? {} : { question }),
      verbose: options.verbose,
    });
  } finally {
    process.off("SIGINT", onSigint);
    await checkout.release();
  }
}

/** `ask --open`: the harness's own interactive CLI, holding the lease until it exits. */
async function openSession(
  ask: AskRun,
  checkout: AskCheckout,
  agent: LoopAgent,
  options: AskOptions,
): Promise<void> {
  const loaded = await loadAnswererInput(ask, checkout.drift);
  const input = await loaded.input([]);
  const context = buildOpenContext(loaded.template, loaded.sharedContext, input);
  note.info(`Opening ${agent.harness} in ${checkout.dir}. Its cost isn't recorded.`);
  const startedAt = new Date();
  // The child gets Ctrl-C itself; this process waits for it to exit.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  let result;
  try {
    result = await openInteractive(
      agent.harness,
      { claudeBin: options.claudeBin, cursorBin: options.cursorBin },
      { cwd: checkout.dir, model: agent.model, context },
    );
  } finally {
    process.off("SIGINT", ignore);
  }
  await recordOpen(ask.paths, {
    harness: agent.harness,
    model: agent.model,
    startedAt,
    durationMs: Date.now() - startedAt.getTime(),
    error: result.error,
    findings: input.findings.state,
  });
  if (result.error !== null) throw new Error(result.error);
}
