import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { codeFence, fillTemplate, promptLibrary } from "./prompts.ts";

function greetDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "prompts-"));
  writeFileSync(path.join(dir, "greet.md"), "Hello {{who}}");
  return dir;
}

describe("promptLibrary", () => {
  it("loads `<name>.md` from its dir and renders it", () => {
    const prompts = promptLibrary<"greet">(pathToFileURL(`${greetDir()}/`));
    expect(prompts.load("greet")).toBe("Hello {{who}}");
    expect(prompts.render("greet", { who: "you" })).toBe("Hello you");
  });

  it("reads each template once", () => {
    const dir = greetDir();
    const prompts = promptLibrary<"greet">(pathToFileURL(`${dir}/`));
    prompts.load("greet");
    writeFileSync(path.join(dir, "greet.md"), "changed");
    expect(prompts.load("greet")).toBe("Hello {{who}}");
  });
});

describe("fillTemplate", () => {
  it("replaces every placeholder occurrence", () => {
    expect(fillTemplate("{{a}} and {{b}} and {{a}}", { a: "1", b: "2" })).toBe("1 and 2 and 1");
  });

  it("does not re-expand placeholders inside values", () => {
    expect(fillTemplate("{{diff}}", { diff: "+ {{base}}" })).toBe("+ {{base}}");
  });

  it("throws on a placeholder without a value", () => {
    expect(() => fillTemplate("{{a}} {{b}}", { a: "1" })).toThrow("{{b}}");
  });

  it("throws on a value without a placeholder", () => {
    expect(() => fillTemplate("{{a}}", { a: "1", extra: "x" })).toThrow("extra");
  });
});

describe("codeFence", () => {
  it("uses a plain triple-backtick fence by default", () => {
    expect(codeFence("x", "diff")).toBe("```diff\nx\n```");
  });

  it("uses a fence longer than any backtick run in the text", () => {
    expect(codeFence(" ```\na ````` b")).toBe("``````\n ```\na ````` b\n``````");
  });
});
