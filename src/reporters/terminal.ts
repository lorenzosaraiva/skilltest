import { Chalk, ChalkInstance } from "chalk";
import { LintIssue, LintReport } from "../core/linter/index.js";
import { TriggerTestResult } from "../core/trigger-tester.js";
import { EvalResult } from "../core/eval-runner.js";
import { CheckRunResult } from "../core/check-runner.js";

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

function gateStatusLabel(value: boolean | null, c: ChalkInstance): string {
  if (value === null) {
    return c.yellow("SKIP");
  }
  return value ? c.green("PASS") : c.red("FAIL");
}

export function renderCheckReport(result: CheckRunResult, enableColor: boolean, verbose: boolean): string {
  const c = getChalkInstance(enableColor);
  const lines: string[] = [];

  const lintGate = gateStatusLabel(result.gates.lintPassed, c);
  const triggerGate = gateStatusLabel(result.gates.triggerPassed, c);
  const evalGate = gateStatusLabel(result.gates.evalPassed, c);
  const overallGate = result.gates.overallPassed ? c.green("PASS") : c.red("FAIL");

  lines.push("skilltest check");
  lines.push(`target: ${result.target}`);
  lines.push(`provider/model: ${result.provider}/${result.model}`);
  lines.push(`grader model: ${result.graderModel}`);
  lines.push(
    `thresholds: min-f1=${result.thresholds.minF1.toFixed(2)} min-assert-pass-rate=${result.thresholds.minAssertPassRate.toFixed(2)}`
  );
  lines.push("");
  lines.push("Lint");
  lines.push(
    `- ${lintGate} ${result.lint.summary.passed}/${result.lint.summary.total} checks passed (${result.lint.summary.warnings} warnings, ${result.lint.summary.failures} failures)`
  );

  const lintIssues = verbose ? result.lint.issues : result.lint.issues.filter((issue) => issue.status !== "pass");
  for (const issue of lintIssues) {
    lines.push(renderIssueLine(issue, c));
  }

  lines.push("");
  lines.push("Trigger");
  if (result.trigger) {
    lines.push(
      `- ${triggerGate} f1=${formatPercent(result.trigger.metrics.f1)} (precision=${formatPercent(result.trigger.metrics.precision)} recall=${formatPercent(result.trigger.metrics.recall)})`
    );
    lines.push(
      `  TP ${result.trigger.metrics.truePositives} TN ${result.trigger.metrics.trueNegatives} FP ${result.trigger.metrics.falsePositives} FN ${result.trigger.metrics.falseNegatives}`
    );

    const triggerCases = verbose ? result.trigger.cases : result.trigger.cases.filter((testCase) => !testCase.matched);
    for (const testCase of triggerCases) {
      const status = testCase.matched ? c.green("PASS") : c.red("FAIL");
      lines.push(`  - ${status} ${testCase.query}`);
      lines.push(`    expected=${testCase.expected} actual=${testCase.actual}`);
    }
  } else {
    lines.push(`- ${triggerGate} ${result.triggerSkippedReason ?? "Skipped."}`);
  }

  lines.push("");
  lines.push("Eval");
  if (result.eval) {
    const passRate = result.gates.evalAssertPassRate ?? 0;
    lines.push(
      `- ${evalGate} assertion pass rate=${formatPercent(passRate)} (${result.eval.summary.passedAssertions}/${result.eval.summary.totalAssertions})`
    );

    for (const promptResult of result.eval.results) {
      const failedAssertions = promptResult.assertions.filter((assertion) => !assertion.passed);
      if (!verbose && failedAssertions.length === 0) {
        continue;
      }
      lines.push(`  - prompt: ${promptResult.prompt}`);
      lines.push(`    response summary: ${promptResult.responseSummary.replace(/\s+/g, " ").trim()}`);
      const assertionsToRender = verbose ? promptResult.assertions : failedAssertions;
      for (const assertion of assertionsToRender) {
        const assertionStatus = assertion.passed ? c.green("PASS") : c.red("FAIL");
        lines.push(`    ${assertionStatus} ${assertion.assertion}`);
        lines.push(`      evidence: ${assertion.evidence}`);
      }
      if (verbose) {
        lines.push(`    full response: ${promptResult.response}`);
      }
    }
  } else {
    lines.push(`- ${evalGate} ${result.evalSkippedReason ?? "Skipped."}`);
  }

  lines.push("");
  lines.push("Quality Gate");
  lines.push(`- lint gate: ${lintGate}`);
  lines.push(`- trigger gate: ${triggerGate}`);
  lines.push(`- eval gate: ${evalGate}`);
  lines.push(`- overall: ${overallGate}`);

  return lines.join("\n");
}
