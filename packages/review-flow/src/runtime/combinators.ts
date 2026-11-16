import pLimit from "p-limit";

/**
 * Makes the context for a branch or item: its work aborts with `signal`, and `onActivity`, when
 * given, is called on each agent activity inside it.
 */
export type Fork<C> = (signal: AbortSignal, onActivity?: () => void) => C;

/**
 * Runs named branches concurrently, each with a context whose signal aborts when another branch
 * throws. The first error is rethrown once all branches have settled.
 */
export async function parallel<C, T extends Record<string, (ctx: C) => Promise<unknown>>>(
  signal: AbortSignal,
  fork: Fork<C>,
  branches: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const own = new AbortController();
  const branchCtx = fork(AbortSignal.any([signal, own.signal]));
  // The first error thrown, which stops the other branches.
  const errors: unknown[] = [];
  const entries = Object.entries(branches);
  const settled = await Promise.allSettled(
    entries.map(([, fn]) =>
      fn(branchCtx).catch((error: unknown) => {
        errors.push(error);
        own.abort(error);
        throw error;
      }),
    ),
  );
  if (errors.length > 0) throw errors[0];
  return Object.fromEntries(
    entries.map(([key], i) => [key, (settled[i] as PromiseFulfilledResult<unknown>).value]),
  ) as never;
}

/**
 * Bounded fan-out. A throw clears the queue, aborts in-flight items, and is rethrown once they
 * have settled. warmFirst: item 0 runs alone until its first agent activity (or its end), so its
 * request writes the shared prompt cache that the others then read.
 */
export async function map<C, T, R>(
  signal: AbortSignal,
  fork: Fork<C>,
  items: readonly T[],
  fn: (item: T, index: number, ctx: C) => Promise<R>,
  { concurrency, warmFirst = false }: { concurrency: number; warmFirst?: boolean },
): Promise<R[]> {
  const warm = Promise.withResolvers<void>();
  if (!warmFirst) warm.resolve();
  // rejectOnClear: otherwise cleared items never settle and allSettled hangs.
  const limit = pLimit({ concurrency, rejectOnClear: true });
  const own = new AbortController();
  const itemSignal = AbortSignal.any([signal, own.signal]);
  // The first thrown error, in the order thrown; cleared items reject later with AbortErrors.
  const errors: unknown[] = [];
  const settled = await Promise.allSettled(
    items.map((item, index) =>
      limit(async () => {
        try {
          if (index > 0) {
            await warm.promise;
            if (itemSignal.aborted) throw itemSignal.reason;
          }
          const ctx = index === 0 ? fork(itemSignal, warm.resolve) : fork(itemSignal);
          const result = await fn(item, index, ctx);
          warm.resolve();
          return result;
        } catch (error) {
          errors.push(error);
          limit.clearQueue();
          own.abort();
          // After the abort, so waiting items see it and don't start.
          warm.resolve();
          throw error;
        }
      }),
    ),
  );
  if (errors.length > 0) throw errors[0];
  return settled.map((s) => (s as PromiseFulfilledResult<R>).value);
}
