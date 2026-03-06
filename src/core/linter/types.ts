import type { ZoneType } from "./markdown-zones.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface LintSkippedPattern {
  label: string;
  zoneType: ZoneType;
  startLine: number;
  endLine: number;
}

export interface LintIssue {
  id: string;
  checkId: string;
  title: string;
  status: CheckStatus;
  message: string;
  suggestion?: string;
  startLine?: number;
  endLine?: number;
  skippedPatterns?: LintSkippedPattern[];
}

export interface LintSummary {
  total: number;
  passed: number;
  warnings: number;
  failures: number;
}

export interface LintReport {
  target: string;
  issues: LintIssue[];
  summary: LintSummary;
}
