import { readFile } from "node:fs/promises";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

export type PromptName = "reviewer" | "verifier" | "change";

export async function loadPrompt(name: PromptName): Promise<string> {
  return readFile(new URL(`${name}.md`, PROMPTS_DIR), "utf8");
}

/**
 * Replaces `{{name}}` placeholders. Throws on a placeholder without a value, and on a value
 * without a placeholder, so template and caller can't drift apart silently.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
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

/**
 * Wraps text in a Markdown code fence longer than any backtick run inside it, so the content
 * can't close the fence early.
 */
export function codeFence(text: string, lang = ""): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}
