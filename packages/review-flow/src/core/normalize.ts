import path from "node:path";
import type {
  FindingsOutput,
  NormalizedFinding,
  NormalizedRoughEdge,
  RoughEdge,
} from "./schemas.ts";

export const MAX_FINDINGS = 15;
export const MAX_ROUGH_EDGES = 5;

export interface NormalizeResult {
  findings: NormalizedFinding[];
  /** Human-readable notes about what normalization changed or dropped. */
  notes: string[];
}

export function findingId(index: number): string {
  return `F-${String(index + 1).padStart(3, "0")}`;
}

/** Repo-relative, forward-slash path; absolute paths inside the repo are made relative. */
export function normalizeFile(file: string, repo: string): string {
  const absolute = path.resolve(repo, file);
  const relative = path.relative(repo, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join("/");
}

/** Caps the list, assigns run-wide ids (F-001…) in reviewer order, and tidies locations. */
export function normalizeFindings(output: FindingsOutput, repo: string): NormalizeResult {
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

export interface NormalizeRoughEdgesResult {
  roughEdges: NormalizedRoughEdge[];
  notes: string[];
}

export function roughEdgeId(index: number): string {
  return `R-${String(index + 1).padStart(3, "0")}`;
}

/** Like normalizeFindings: caps the list, assigns ids (R-001…) in reviewer order, tidies locations. */
export function normalizeRoughEdges(
  reviewed: readonly RoughEdge[],
  repo: string,
): NormalizeRoughEdgesResult {
  const notes: string[] = [];
  let edges = reviewed;
  if (edges.length > MAX_ROUGH_EDGES) {
    notes.push(`Reviewer returned ${edges.length} rough edges; kept the first ${MAX_ROUGH_EDGES}.`);
    edges = edges.slice(0, MAX_ROUGH_EDGES);
  }
  const roughEdges = edges.map((edge, index): NormalizedRoughEdge => {
    const id = roughEdgeId(index);
    const file = normalizeFile(edge.file, repo);
    let { lineStart, lineEnd } = edge;
    if (lineEnd < lineStart) {
      notes.push(`${id}: swapped reversed line range ${lineStart}-${lineEnd}.`);
      [lineStart, lineEnd] = [lineEnd, lineStart];
    }
    return { id, ...edge, file, lineStart, lineEnd };
  });
  return { roughEdges, notes };
}
