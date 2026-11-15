import { promptLibrary } from "../runtime/prompts.ts";

export type PromptName =
  | "summarizer"
  | "reviewer"
  | "verifier"
  | "answerer"
  | "change"
  | "judge"
  | "rough-edges"
  | "rough-edge-checker"
  | "rough-edge-judge"
  | "rough-edge-pairwise";

// prompts/ at the package root, from both src/review/ and dist/review/.
const prompts = promptLibrary<PromptName>(new URL("../../prompts/", import.meta.url));

/** A raw prompt template, e.g. to include in another prompt. Prefer `renderPrompt`. */
export const loadPrompt = prompts.load;

/** Loads the named prompt and fills in its placeholders. */
export const renderPrompt = prompts.render;
