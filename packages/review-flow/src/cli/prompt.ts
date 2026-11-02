import { createInterface } from "node:readline/promises";

export const interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** Asks on stderr so stdout stays clean for --quiet. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N]: `));
}

/**
 * Parses a selection such as `1,3-4` against `count` items (1-based) into 0-based indexes.
 * null when the input is malformed or out of range.
 */
export function parseSelection(input: string, count: number): number[] | null {
  const picked = new Set<number>();
  for (const part of input.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (match === null) return null;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to > count || from > to) return null;
    for (let i = from; i <= to; i++) picked.add(i - 1);
  }
  return [...picked].toSorted((a, b) => a - b);
}
