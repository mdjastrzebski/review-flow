export type Severity = "info" | "warning" | "error";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} [${finding.severity}] ${finding.message}`;
}
