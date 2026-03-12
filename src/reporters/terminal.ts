import { Chalk, ChalkInstance } from "chalk";
import { LintIssue, LintReport } from "../core/linter/index.js";
import { TriggerTestResult } from "../core/trigger-tester.js";
import { EvalResult } from "../core/eval-runner.js";
import { CheckRunResult } from "../core/check-runner.js";
import { ImproveRunResult } from "../core/improver.js";

function getChalkInstance(enableColor: boolean): ChalkInstance {
  return new Chalk({ level: enableColor ? 1 : 0 });
}

function renderIssueLine(issue: LintIssue, c: ChalkInstance): string {
  const label =
    issue.status === "pass" ? c.green("PASS") : issue.status === "warn" ? c.yellow("WARN") : c.red("FAIL");
  const detail = issue.suggestion ? `\n      suggestion: ${issue.suggestion}` : "";
  return `  ${label} ${issue.title}\n      ${issue.message}${detail}`;
}

function countSkippedSecurityPatterns(issues: LintIssue[]): number {
  return issues.reduce((total, issue) => {
    if (!issue.checkId.startsWith("security:")) {
      return total;
    }
    return total + (issue.skippedPatterns?.length ?? 0);
  }, 0);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedNumber(value: number, digits = 4): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}`;
}

function diffChangedLines(beforeText: string, afterText: string): Array<{ type: "+" | "-"; line: string }> {
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  const dp = Array.from({ length: beforeLines.length + 1 }, () => Array<number>(afterLines.length + 1).fill(0));

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
        dp[beforeIndex]![afterIndex] = 1 + (dp[beforeIndex + 1]![afterIndex + 1] ?? 0);
      } else {
        dp[beforeIndex]![afterIndex] = Math.max(dp[beforeIndex + 1]![afterIndex] ?? 0, dp[beforeIndex]![afterIndex + 1] ?? 0);
      }
    }
  }

  const changedLines: Array<{ type: "+" | "-"; line: string }> = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    const skipBefore = dp[beforeIndex + 1]![afterIndex] ?? 0;
    const skipAfter = dp[beforeIndex]![afterIndex + 1] ?? 0;
    if (skipBefore >= skipAfter) {
      changedLines.push({ type: "-", line: beforeLines[beforeIndex] ?? "" });
      beforeIndex += 1;
    } else {
      changedLines.push({ type: "+", line: afterLines[afterIndex] ?? "" });
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeLines.length) {
    changedLines.push({ type: "-", line: beforeLines[beforeIndex] ?? "" });
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    changedLines.push({ type: "+", line: afterLines[afterIndex] ?? "" });
    afterIndex += 1;
  }

  return changedLines;
}

function renderDiffPreview(beforeText: string, afterText: string, maxLines = 40): string[] {
  const changedLines = diffChangedLines(beforeText, afterText);
  if (changedLines.length === 0) {
    return ["  (no content changes)"];
  }

  const previewLines = changedLines.slice(0, maxLines).map((entry) => `  ${entry.type} ${entry.line}`);
  if (changedLines.length > maxLines) {
    previewLines.push(`  ... ${changedLines.length - maxLines} more changed line(s)`);
  }
  return previewLines;
}

function summarizeToolCalls(toolCalls: NonNullable<EvalResult["results"][number]["toolCalls"]>): string {
  const counts = new Map<string, number>();
  for (const toolCall of toolCalls) {
    counts.set(toolCall.name, (counts.get(toolCall.name) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
}

export function renderLintReport(report: LintReport, enableColor: boolean): string {
  const c = getChalkInstance(enableColor);
  const { passed, warnings, failures, total } = report.summary;
  const headerLines = [
    "skilltest lint",
    `target: ${report.target}`,
    `summary: ${passed}/${total} checks passed, ${warnings} warnings, ${failures} failures`
  ];

  const renderedIssues = report.issues.map((issue) => renderIssueLine(issue, c)).join("\n");
  const skippedSecurityPatterns = countSkippedSecurityPatterns(report.issues);
  const infoLine =
    skippedSecurityPatterns > 0
      ? `\n  ${c.cyan("INFO")} ${skippedSecurityPatterns} security pattern(s) found in code examples/comments (not flagged)`
      : "";

  return `${headerLines.join("\n")}\n${renderedIssues}${infoLine}`;
}

export function renderTriggerReport(result: TriggerTestResult, enableColor: boolean, verbose: boolean): string {
  const c = getChalkInstance(enableColor);
  const lines: string[] = [
    "skilltest trigger",
    `skill: ${result.skillName}`,
    `provider/model: ${result.provider}/${result.model}`
  ];

  if (result.competitors && result.competitors.length > 0) {
    lines.push(`competitors: ${result.competitors.map((competitor) => competitor.name).join(", ")}`);
  }

  lines.push(
    `precision: ${formatPercent(result.metrics.precision)}  recall: ${formatPercent(result.metrics.recall)}  f1: ${formatPercent(result.metrics.f1)}`
  );
  lines.push(
    `TP ${result.metrics.truePositives}  TN ${result.metrics.trueNegatives}  FP ${result.metrics.falsePositives}  FN ${result.metrics.falseNegatives}`
  );

  for (const [index, testCase] of result.cases.entries()) {
    const status = testCase.matched ? c.green("PASS") : c.red("FAIL");
    lines.push(`${index + 1}. ${status} query: ${testCase.query}`);
    lines.push(`   expected: ${testCase.expected} | actual: ${testCase.actual}`);
    if (verbose && testCase.selectedCompetitor) {
      lines.push(`   competitor selected: ${testCase.selectedCompetitor}`);
    }
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
  const lines: string[] = [
    "skilltest eval",
    `skill: ${result.skillName}`,
    `provider/model: ${result.provider}/${result.model}`,
    `grader model: ${result.graderModel}`,
    `assertions passed: ${result.summary.passedAssertions}/${result.summary.totalAssertions}`
  ];

  for (const [index, promptResult] of result.results.entries()) {
    lines.push(`${index + 1}. prompt: ${promptResult.prompt}`);
    lines.push(`   response summary: ${promptResult.responseSummary.replace(/\s+/g, " ").trim()}`);
    if (promptResult.toolCalls) {
      lines.push(`   Tools: ${promptResult.toolCalls.length} calls (${summarizeToolCalls(promptResult.toolCalls)})`);
      if (promptResult.loopIterations !== undefined) {
        lines.push(`   loop iterations: ${promptResult.loopIterations}`);
      }
    }
    for (const assertion of promptResult.assertions) {
      const status = assertion.passed ? c.green("PASS") : c.red("FAIL");
      lines.push(`   ${status} ${assertion.assertion}`);
      lines.push(`      evidence: ${assertion.evidence}`);
    }
    if (verbose) {
      if (promptResult.toolCalls) {
        for (const toolCall of promptResult.toolCalls) {
          lines.push(`   tool ${toolCall.turnIndex}: ${toolCall.name}`);
          lines.push(`      arguments: ${JSON.stringify(toolCall.arguments)}`);
          lines.push(`      response: ${toolCall.response}`);
        }
      }
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

  const skippedSecurityPatterns = countSkippedSecurityPatterns(result.lint.issues);
  if (skippedSecurityPatterns > 0) {
    lines.push(`  ${c.cyan("INFO")} ${skippedSecurityPatterns} security pattern(s) found in code examples/comments (not flagged)`);
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
    if (result.trigger.competitors && result.trigger.competitors.length > 0) {
      lines.push(`  competitors: ${result.trigger.competitors.map((competitor) => competitor.name).join(", ")}`);
    }

    const triggerCases = verbose ? result.trigger.cases : result.trigger.cases.filter((testCase) => !testCase.matched);
    for (const testCase of triggerCases) {
      const status = testCase.matched ? c.green("PASS") : c.red("FAIL");
      lines.push(`  - ${status} ${testCase.query}`);
      lines.push(`    expected=${testCase.expected} actual=${testCase.actual}`);
      if (testCase.selectedCompetitor) {
        lines.push(`    competitor selected=${testCase.selectedCompetitor}`);
      }
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
      if (promptResult.toolCalls) {
        lines.push(`    Tools: ${promptResult.toolCalls.length} calls (${summarizeToolCalls(promptResult.toolCalls)})`);
        if (promptResult.loopIterations !== undefined) {
          lines.push(`    loop iterations: ${promptResult.loopIterations}`);
        }
      }
      const assertionsToRender = verbose ? promptResult.assertions : failedAssertions;
      for (const assertion of assertionsToRender) {
        const assertionStatus = assertion.passed ? c.green("PASS") : c.red("FAIL");
        lines.push(`    ${assertionStatus} ${assertion.assertion}`);
        lines.push(`      evidence: ${assertion.evidence}`);
      }
      if (verbose) {
        if (promptResult.toolCalls) {
          for (const toolCall of promptResult.toolCalls) {
            lines.push(`    tool ${toolCall.turnIndex}: ${toolCall.name}`);
            lines.push(`      arguments: ${JSON.stringify(toolCall.arguments)}`);
            lines.push(`      response: ${toolCall.response}`);
          }
        }
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

export function renderImproveReport(result: ImproveRunResult, enableColor: boolean, verbose = false): string {
  const c = getChalkInstance(enableColor);
  const lines: string[] = [
    "skilltest improve",
    `target: ${result.target}`,
    `provider/model: ${result.provider}/${result.model}`,
    `thresholds: min-f1=${result.thresholds.minF1.toFixed(2)} min-assert-pass-rate=${result.thresholds.minAssertPassRate.toFixed(2)}`
  ];

  const statusLabel = result.blockedReason ? c.red("BLOCKED") : result.applied ? c.green("APPLIED") : c.green("VERIFIED");
  lines.push(`status: ${statusLabel}`);

  if (result.candidate) {
    lines.push("");
    lines.push("Change Summary");
    for (const item of result.candidate.changeSummary) {
      lines.push(`- ${item}`);
    }

    lines.push("");
    lines.push("Targeted Problems");
    for (const item of result.candidate.targetedProblems) {
      lines.push(`- ${item}`);
    }
  }

  if (result.delta && result.verification) {
    lines.push("");
    lines.push("Before / After");
    lines.push(
      `- lint failures: ${result.delta.lintFailures.before} -> ${result.delta.lintFailures.after} (${formatSignedNumber(result.delta.lintFailures.delta, 0)})`
    );
    lines.push(
      `- lint warnings: ${result.delta.lintWarnings.before} -> ${result.delta.lintWarnings.after} (${formatSignedNumber(result.delta.lintWarnings.delta, 0)})`
    );
    lines.push(
      `- trigger f1: ${formatPercent(result.delta.triggerF1.before)} -> ${formatPercent(result.delta.triggerF1.after)} (${formatSignedNumber(result.delta.triggerF1.delta)})`
    );
    lines.push(
      `- eval assertion pass rate: ${formatPercent(result.delta.evalAssertPassRate.before)} -> ${formatPercent(result.delta.evalAssertPassRate.after)} (${formatSignedNumber(result.delta.evalAssertPassRate.delta)})`
    );
    lines.push(
      `- overall gate: ${result.delta.overallPassed.before ? c.green("PASS") : c.red("FAIL")} -> ${result.delta.overallPassed.after ? c.green("PASS") : c.red("FAIL")}`
    );
  }

  if (result.outputPath) {
    lines.push("");
    lines.push(`output: ${result.outputPath}`);
  }

  if (result.blockedReason) {
    lines.push("");
    lines.push("Blocked");
    lines.push(`- ${result.blockedReason}`);
  }

  if (result.candidate) {
    lines.push("");
    lines.push("Diff Preview");
    lines.push(...renderDiffPreview(result.originalRaw, result.candidate.raw));
  }

  if (verbose) {
    lines.push("");
    lines.push("Baseline");
    lines.push(renderCheckReport(result.baseline, enableColor, true));
    if (result.verification) {
      lines.push("");
      lines.push("Verification");
      lines.push(renderCheckReport(result.verification, enableColor, true));
    }
  }

  return lines.join("\n");
}
