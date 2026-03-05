export type CheckStatus = "pass" | "warn" | "fail";

export interface LintIssue {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  suggestion?: string;
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
