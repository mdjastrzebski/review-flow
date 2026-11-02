import * as clack from "@clack/prompts";

export const interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

// Prompts draw on stderr so stdout stays clean for --quiet. Ctrl-C or Esc cancels a prompt.
const output = process.stderr;

/** Free text; `fallback` when left empty. null when cancelled. */
export async function ask(message: string, fallback: string): Promise<string | null> {
  const answer = await clack.text({
    message,
    placeholder: fallback,
    defaultValue: fallback,
    output,
  });
  return clack.isCancel(answer) ? null : answer.trim() || fallback;
}

/** One of `options`. null when cancelled. */
export async function choose<T extends string>(
  message: string,
  options: readonly T[],
  initial: T,
): Promise<T | null> {
  const answer = await clack.select<string>({
    message,
    options: options.map((value) => ({ value })),
    initialValue: initial,
    output,
  });
  return clack.isCancel(answer) ? null : (options.find((value) => value === answer) ?? null);
}

/** A cancelled prompt counts as no. */
export async function confirm(message: string): Promise<boolean> {
  const answer = await clack.confirm({ message, initialValue: false, output });
  return answer === true;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Arrow keys move, Space marks, Enter accepts. May be empty; null when cancelled. */
export async function pick<T extends string>(
  message: string,
  choices: readonly Choice<T>[],
  initial: readonly T[],
): Promise<T[] | null> {
  const answer = await clack.multiselect<string>({
    message,
    options: [...choices],
    initialValues: [...initial],
    required: false,
    output,
  });
  return clack.isCancel(answer)
    ? null
    : choices.flatMap((c) => (answer.includes(c.value) ? [c.value] : []));
}

/** Status lines around prompts, on stderr like the prompts themselves. */
export const note = {
  info: (message: string) => clack.log.info(message, { output }),
  warn: (message: string) => clack.log.warn(message, { output }),
  box: (message: string, title: string) => clack.note(message, title, { output }),
};
