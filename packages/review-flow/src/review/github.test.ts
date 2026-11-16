import { describe, expect, it } from "vitest";
import { matchRemote, parsePrTarget } from "./github.ts";

describe("parsePrTarget", () => {
  it("accepts numbers, #numbers, and PR URLs", () => {
    expect(parsePrTarget("123")).toBe("123");
    expect(parsePrTarget("#7")).toBe("7");
    const url = "https://github.com/acme/app/pull/42/files";
    expect(parsePrTarget(url)).toBe(url);
  });

  it("rejects branches, commits, and other URLs", () => {
    expect(parsePrTarget("feature/x")).toBeNull();
    expect(parsePrTarget("abc123f")).toBeNull();
    expect(parsePrTarget("https://github.com/acme/app/issues/42")).toBeNull();
  });
});

describe("matchRemote", () => {
  const pr = { host: "github.com", repo: "Acme/App" };

  it("matches https, ssh, and scp-like URLs, ignoring case and .git", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "https://user@github.com/acme/app",
      "git@github.com:acme/app.git",
      "ssh://git@github.com:22/acme/app.git",
    ]) {
      expect(matchRemote(new Map([["up", url]]), pr)).toBe("up");
    }
  });

  it("prefers origin, and returns null when nothing matches", () => {
    const remotes = new Map([
      ["fork", "git@github.com:me/app.git"],
      ["upstream", "git@github.com:acme/app.git"],
      ["origin", "https://github.com/acme/app"],
    ]);
    expect(matchRemote(remotes, pr)).toBe("origin");
    expect(matchRemote(new Map([["fork", "git@github.com:me/app.git"]]), pr)).toBeNull();
    expect(matchRemote(new Map([["ghe", "git@ghe.acme.com:acme/app.git"]]), pr)).toBeNull();
  });
});
