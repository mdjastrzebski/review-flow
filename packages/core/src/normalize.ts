import path from "node:path";
import type { NormalizedFinding, ReviewOutput } from "./schemas.ts";

export const MAX_FINDINGS = 15;

export interface NormalizeResult {
  findings: NormalizedFinding[];
  /** Human-readable notes about what normalization changed or dropped. */
  notes: string[];
}

export function findingId(index: number): string {
  return `F-${String(index + 1).padStart(3, "0")}`;
}

/** Repo-relative, forward-slash path; absolute paths inside the repo are made relative. */
function normalizeFile(file: string, repo: string): string {
  const absolute = path.resolve(repo, file);
  const relative = path.relative(repo, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join("/");
}

/** Caps the list, assigns run-wide ids (F-001…) in reviewer order, and tidies locations. */
export function normalizeFindings(output: ReviewOutput, repo: string): NormalizeResult {
  const notes: string[] = [];
  let findings = output.findings;
  if (findings.length > MAX_FINDINGS) {
    notes.push(`Reviewer returned ${findings.length} findings; kept the first ${MAX_FINDINGS}.`);
    findings = findings.slice(0, MAX_FINDINGS);
  }

  const normalized = findings.map((finding, index): NormalizedFinding => {
    const id = findingId(index);
    const file = normalizeFile(finding.file, repo);
    let { lineStart, lineEnd } = finding;
    if (lineEnd < lineStart) {
      notes.push(`${id}: swapped reversed line range ${lineStart}-${lineEnd}.`);
      [lineStart, lineEnd] = [lineEnd, lineStart];
    }
    return { id, ...finding, file, lineStart, lineEnd };
  });

  return { findings: normalized, notes };
}
