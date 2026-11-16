import { describe, expect, it } from "vitest";
import { map, parallel, type Fork } from "./combinators.ts";

/** A context that is just its signal and an activity callback, as a forked flow context would carry. */
interface Ctx {
  signal: AbortSignal;
  activity: () => void;
}

const fork: Fork<Ctx> = (signal, onActivity) => ({ signal, activity: onActivity ?? (() => {}) });
const never = new AbortController().signal;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when the signal aborts, or at once if it has. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

describe("parallel", () => {
  it("returns each branch's result under its key", async () => {
    expect(await parallel(never, fork, { a: async () => 1, b: async () => "two" })).toEqual({
      a: 1,
      b: "two",
    });
  });

  it("aborts the other branches on a throw and rethrows once they settle", async () => {
    let settled = false;
    const run = parallel(never, fork, {
      broken: async () => {
        throw new Error("broke");
      },
      waiting: async (ctx) => {
        await aborted(ctx.signal);
        settled = true;
      },
    });
    await expect(run).rejects.toThrow("broke");
    expect(settled).toBe(true);
  });
});

describe("map", () => {
  it("bounds concurrency and keeps the results in order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await map(
      never,
      fork,
      ["a", "b", "c", "d", "e"],
      async (item, index) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active--;
        return `${index}:${item}`;
      },
      { concurrency: 2 },
    );
    expect(results).toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    expect(maxActive).toBe(2);
  });

  it("with warmFirst, holds the rest until the first item reports activity", async () => {
    const events: string[] = [];
    await map(
      never,
      fork,
      ["a", "b", "c"],
      async (item, _index, ctx) => {
        events.push(`start ${item}`);
        if (item !== "a") return;
        await sleep(10);
        events.push("activity");
        ctx.activity();
        await sleep(10);
      },
      { concurrency: 3, warmFirst: true },
    );
    expect(events.slice(0, 2)).toEqual(["start a", "activity"]);
    expect(events.toSorted()).toEqual(["activity", "start a", "start b", "start c"]);
  });

  it("on a throw, starts no queued item, aborts in-flight ones, and rethrows", async () => {
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    const run = map(
      never,
      fork,
      ["a", "b", "c", "d", "e"],
      async (item, _index, ctx) => {
        started.push(item);
        signals.push(ctx.signal);
        if (item === "b") throw new Error("b broke");
        await aborted(ctx.signal);
      },
      { concurrency: 3 },
    );
    await expect(run).rejects.toThrow("b broke");
    expect(started.toSorted()).toEqual(["a", "b", "c"]);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("aborts its items when the outer signal aborts", async () => {
    const outer = new AbortController();
    const run = map(
      outer.signal,
      fork,
      ["a"],
      async (_item, _index, ctx) => {
        await aborted(ctx.signal);
        throw ctx.signal.reason;
      },
      { concurrency: 1 },
    );
    outer.abort(new Error("stopped"));
    await expect(run).rejects.toThrow("stopped");
  });
});
