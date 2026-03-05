import { Chalk, ChalkInstance } from "chalk";
import { LintIssue, LintReport } from "../core/linter/index.js";
import { TriggerTestResult } from "../core/trigger-tester.js";
import { EvalResult } from "../core/eval-runner.js";

function getChalkInstance(enableColor: boolean): ChalkInstance {
  return new Chalk({ level: enableColor ? 1 : 0 });
}

function renderIssueLine(issue: LintIssue, c: ChalkInstance): string {
  const label =
    issue.status === "pass" ? c.green("PASS") : issue.status === "warn" ? c.yellow("WARN") : c.red("FAIL");
  const detail = issue.suggestion ? `\n      suggestion: ${issue.suggestion}` : "";
  return `  ${label} ${issue.title}\n      ${issue.message}${detail}`;
}

export function renderLintReport(report: LintReport, enableColor: boolean): string {
  const c = getChalkInstance(enableColor);
  const { passed, warnings, failures, total } = report.summary;

  const headerLines = [
    `┌───────────────────────────────────────────────────────────────┐`,
    `│ skilltest lint                                                │`,
    `├───────────────────────────────────────────────────────────────┤`,
    `│ target: ${report.target}`,
    `│ summary: ${passed}/${total} checks passed, ${warnings} warnings, ${failures} failures`,
    `└───────────────────────────────────────────────────────────────┘`
  ];

  const renderedIssues = report.issues.map((issue) => renderIssueLine(issue, c)).join("\n");
  return `${headerLines.join("\n")}\n${renderedIssues}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderTriggerReport(result: TriggerTestResult, enableColor: boolean, verbose: boolean): string {
  const c = getChalkInstance(enableColor);
  const lines: string[] = [];
  lines.push("┌───────────────────────────────────────────────────────────────┐");
  lines.push("│ skilltest trigger                                             │");
  lines.push("├───────────────────────────────────────────────────────────────┤");
  lines.push(`│ skill: ${result.skillName}`);
  lines.push(`│ provider/model: ${result.provider}/${result.model}`);
  lines.push(
    `│ precision: ${formatPercent(result.metrics.precision)}  recall: ${formatPercent(result.metrics.recall)}  f1: ${formatPercent(result.metrics.f1)}`
  );
  lines.push(
    `│ TP ${result.metrics.truePositives}  TN ${result.metrics.trueNegatives}  FP ${result.metrics.falsePositives}  FN ${result.metrics.falseNegatives}`
  );
  lines.push("└───────────────────────────────────────────────────────────────┘");

  for (const [index, testCase] of result.cases.entries()) {
    const status = testCase.matched ? c.green("PASS") : c.red("FAIL");
    lines.push(`${index + 1}. ${status} query: ${testCase.query}`);
    lines.push(`   expected: ${testCase.expected} | actual: ${testCase.actual}`);
    if (verbose && testCase.rawModelResponse) {
      lines.push(`   model: ${testCase.rawModelResponse.replace(/\s+/g, " ").trim()}`);
    }
  }

  lines.push("Suggestions:");
  for (const suggestion of result.suggestions) {
    lines.push(`- ${suggestion}`);
  }

  return lines.join("\n");
}

export function renderEvalReport(result: EvalResult, enableColor: boolean, verbose: boolean): string {
  const c = getChalkInstance(enableColor);
  const lines: string[] = [];
  lines.push("┌───────────────────────────────────────────────────────────────┐");
  lines.push("│ skilltest eval                                                │");
  lines.push("├───────────────────────────────────────────────────────────────┤");
  lines.push(`│ skill: ${result.skillName}`);
  lines.push(`│ provider/model: ${result.provider}/${result.model}`);
  lines.push(`│ grader model: ${result.graderModel}`);
  lines.push(`│ assertions passed: ${result.summary.passedAssertions}/${result.summary.totalAssertions}`);
  lines.push("└───────────────────────────────────────────────────────────────┘");

  for (const [index, promptResult] of result.results.entries()) {
    lines.push(`${index + 1}. prompt: ${promptResult.prompt}`);
    lines.push(`   response summary: ${promptResult.responseSummary.replace(/\s+/g, " ").trim()}`);
    for (const assertion of promptResult.assertions) {
      const status = assertion.passed ? c.green("PASS") : c.red("FAIL");
      lines.push(`   ${status} ${assertion.assertion}`);
      lines.push(`      evidence: ${assertion.evidence}`);
    }
    if (verbose) {
      lines.push(`   full response: ${promptResult.response}`);
    }
  }

  return lines.join("\n");
}
