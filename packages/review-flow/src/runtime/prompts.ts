import { readFileSync } from "node:fs";

/**
 * Wraps text in a Markdown code fence longer than any backtick run inside it, so the content
 * can't close the fence early.
 */
export function codeFence(text: string, lang = ""): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

export interface PromptLibrary<Name extends string> {
  /** The raw template, read on first use and kept for the process. */
  load(name: Name): string;
  /** The template with its placeholders filled, as `fillTemplate` does. */
  render(name: Name, vars: PromptVars): string;
}

export type PromptVars = Record<string, string>;

/**
 * Prompt templates stored as `<name>.md` in `dir`. Reads are sync: prompt files are small and
 * ship with the code, so one blocking read per prompt costs nothing next to an agent call.
 */
export function promptLibrary<Name extends string>(dir: URL): PromptLibrary<Name> {
  const loaded = new Map<Name, string>();
  const load = (name: Name): string => {
    let template = loaded.get(name);
    if (template === undefined) {
      template = readFileSync(new URL(`${name}.md`, dir), "utf8");
      loaded.set(name, template);
    }
    return template;
  };
  return { load, render: (name, vars) => fillTemplate(load(name), vars) };
}

/**
 * Replaces `{{name}}` placeholders. Throws on a placeholder without a value, and on a value
 * without a placeholder, so template and caller can't drift apart silently.
 */
export function fillTemplate(template: string, vars: PromptVars): string {
  const used = new Set<string>();
  const rendered = template.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Prompt placeholder {{${key}}} has no value`);
    used.add(key);
    return value;
  });
  const unused = Object.keys(vars).filter((key) => !used.has(key));
  if (unused.length > 0) throw new Error(`Prompt has no placeholder for: ${unused.join(", ")}`);
  return rendered;
}
