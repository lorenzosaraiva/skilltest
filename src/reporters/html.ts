import { CheckRunResult } from "../core/check-runner.js";
import { EvalPromptResult, EvalResult } from "../core/eval-runner.js";
import { LintIssue, LintReport } from "../core/linter/index.js";
import { TriggerTestCaseResult, TriggerTestResult } from "../core/trigger-tester.js";

type HtmlStatus = "pass" | "warn" | "fail" | "skip";

interface StatCard {
  label: string;
  value: string;
  note?: string;
  status?: HtmlStatus;
}

interface MetaItem {
  label: string;
  value: string;
}

function escapeHtml(value: string | number | undefined | null): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatLineRange(startLine?: number, endLine?: number): string | null {
  if (startLine === undefined) {
    return null;
  }

  if (endLine === undefined || endLine === startLine) {
    return `line ${startLine}`;
  }

  return `lines ${startLine}-${endLine}`;
}

function badgeLabel(status: HtmlStatus): string {
  if (status === "pass") {
    return "PASS";
  }
  if (status === "warn") {
    return "WARN";
  }
  if (status === "fail") {
    return "FAIL";
  }
  return "SKIP";
}

function renderBadge(status: HtmlStatus): string {
  return `<span class="badge ${status}">${badgeLabel(status)}</span>`;
}

function renderStatCards(stats: StatCard[]): string {
  return `<div class="stats-grid">${stats
    .map(
      (stat) => `
        <div class="stat-card${stat.status ? ` status-${stat.status}` : ""}">
          <div class="stat-label">${escapeHtml(stat.label)}</div>
          <div class="stat-value">${escapeHtml(stat.value)}</div>
          ${stat.note ? `<div class="stat-note">${escapeHtml(stat.note)}</div>` : ""}
        </div>
      `
    )
    .join("")}</div>`;
}

function renderMetaItems(items: MetaItem[]): string {
  if (items.length === 0) {
    return "";
  }

  return `<div class="meta-grid">${items
    .map(
      (item) => `
        <div class="meta-item">
          <span class="meta-label">${escapeHtml(item.label)}</span>
          <span class="meta-value">${escapeHtml(item.value)}</span>
        </div>
      `
    )
    .join("")}</div>`;
}

function renderHeaderCard(
  commandName: string,
  heading: string,
  target: string,
  stats: StatCard[],
  metaItems: MetaItem[]
): string {
  return `
    <section class="card header-card">
      <div class="eyebrow">skilltest ${escapeHtml(commandName)}</div>
      <h1>${escapeHtml(heading)}</h1>
      <div class="target-line">target: ${escapeHtml(target)}</div>
      ${renderMetaItems(metaItems)}
      ${renderStatCards(stats)}
    </section>
  `;
}

function renderSectionCard(title: string, body: string): string {
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>
  `;
}

function renderMessageRow(status: HtmlStatus, title: string, message: string, details?: string): string {
  return `
    <div class="row">
      <div class="row-header">
        <div class="row-title">${escapeHtml(title)}</div>
        ${renderBadge(status)}
      </div>
      <div class="row-body">${escapeHtml(message)}</div>
      ${details ?? ""}
    </div>
  `;
}

function renderDetails(summary: string, content: string): string {
  return `
    <details class="detail-block">
      <summary>${escapeHtml(summary)}</summary>
      <div class="detail-content">${content}</div>
    </details>
  `;
}

function renderPreBlock(content: string): string {
  return `<pre>${escapeHtml(content)}</pre>`;
}

function renderDefinitionList(items: MetaItem[]): string {
  return `<div class="definition-list">${items
    .map(
      (item) => `
        <div class="definition-item">
          <div class="definition-label">${escapeHtml(item.label)}</div>
          <div class="definition-value">${escapeHtml(item.value)}</div>
        </div>
      `
    )
    .join("")}</div>`;
}

function countSkippedSecurityPatterns(issues: LintIssue[]): number {
  return issues.reduce((total, issue) => total + (issue.skippedPatterns?.length ?? 0), 0);
}

function renderLintIssueRow(issue: LintIssue): string {
  const lineRange = formatLineRange(issue.startLine, issue.endLine);
  const detailBlocks: string[] = [];

  if (issue.suggestion) {
    detailBlocks.push(renderDetails("Suggestion", `<p>${escapeHtml(issue.suggestion)}</p>`));
  }

  if (issue.skippedPatterns && issue.skippedPatterns.length > 0) {
    const patternItems = issue.skippedPatterns
      .map(
        (pattern) => `
          <div class="definition-item">
            <div class="definition-label">${escapeHtml(pattern.label)}</div>
            <div class="definition-value">${escapeHtml(
              `${pattern.zoneType} lines ${pattern.startLine}-${pattern.endLine}`
            )}</div>
          </div>
        `
      )
      .join("");
    detailBlocks.push(renderDetails("Skipped security patterns", `<div class="definition-list">${patternItems}</div>`));
  }

  return `
    <div class="row">
      <div class="row-header">
        <div>
          <div class="row-title">${escapeHtml(issue.title)}</div>
          <div class="row-subtitle">${escapeHtml(issue.checkId)}</div>
        </div>
        ${renderBadge(issue.status)}
      </div>
      <div class="row-body">${escapeHtml(issue.message)}</div>
      ${renderDefinitionList(
        [
          lineRange ? { label: "Location", value: lineRange } : null,
          { label: "Check ID", value: issue.checkId }
        ].filter((item): item is MetaItem => item !== null)
      )}
      ${detailBlocks.join("")}
    </div>
  `;
}

function renderLintIssueList(report: LintReport): string {
  const skippedSecurityPatterns = countSkippedSecurityPatterns(report.issues);
  const rows = report.issues.map((issue) => renderLintIssueRow(issue)).join("");
  const info =
    skippedSecurityPatterns > 0
      ? `<p class="info-line">Skipped security patterns in examples/comments: ${escapeHtml(skippedSecurityPatterns)}</p>`
      : "";

  return `<div class="row-list">${rows}</div>${info}`;
}

function renderTriggerCaseRow(testCase: TriggerTestCaseResult): string {
  const details = testCase.rawModelResponse
    ? renderDetails("Model response", renderPreBlock(testCase.rawModelResponse))
    : "";

  return `
    <div class="row">
      <div class="row-header">
        <div>
          <div class="row-title">${escapeHtml(testCase.query)}</div>
          <div class="row-subtitle">${escapeHtml(
            `expected=${testCase.expected} actual=${testCase.actual} should_trigger=${String(testCase.shouldTrigger)}`
          )}</div>
        </div>
        ${renderBadge(testCase.matched ? "pass" : "fail")}
      </div>
      ${renderDefinitionList([
        { label: "Expected", value: testCase.expected },
        { label: "Actual", value: testCase.actual }
      ])}
      ${details}
    </div>
  `;
}

function promptStatus(promptResult: EvalPromptResult): HtmlStatus {
  if (promptResult.totalAssertions === 0) {
    return "skip";
  }
  if (promptResult.passedAssertions === promptResult.totalAssertions) {
    return "pass";
  }
  if (promptResult.passedAssertions === 0) {
    return "fail";
  }
  return "warn";
}

function renderAssertionRow(assertion: EvalPromptResult["assertions"][number]): string {
  return renderDetails(
    `${badgeLabel(assertion.passed ? "pass" : "fail")} ${assertion.assertion}`,
    renderPreBlock(assertion.evidence)
  );
}

function renderEvalPromptRow(promptResult: EvalPromptResult): string {
  const assertionDetails = promptResult.assertions.map((assertion) => renderAssertionRow(assertion)).join("");
  const responseDetails = renderDetails("Full model response", renderPreBlock(promptResult.response));

  return `
    <div class="row">
      <div class="row-header">
        <div>
          <div class="row-title">${escapeHtml(promptResult.prompt)}</div>
          <div class="row-subtitle">${escapeHtml(
            `${promptResult.passedAssertions}/${promptResult.totalAssertions} assertions passed`
          )}</div>
        </div>
        ${renderBadge(promptStatus(promptResult))}
      </div>
      <div class="row-body">${escapeHtml(promptResult.responseSummary)}</div>
      ${renderDefinitionList([
        { label: "Passed assertions", value: String(promptResult.passedAssertions) },
        { label: "Total assertions", value: String(promptResult.totalAssertions) }
      ])}
      ${renderDetails("Assertion evidence", assertionDetails || `<p>No assertions.</p>`)}
      ${responseDetails}
    </div>
  `;
}

function gateStatus(value: boolean | null): HtmlStatus {
  if (value === null) {
    return "skip";
  }
  return value ? "pass" : "fail";
}

function renderGateCard(title: string, status: HtmlStatus, message: string): string {
  return `
    <div class="gate-card">
      <div class="row-header">
        <div class="row-title">${escapeHtml(title)}</div>
        ${renderBadge(status)}
      </div>
      <div class="row-body">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderCollapsibleSection(title: string, summary: string, body: string, status: HtmlStatus): string {
  return `
    <details class="section-card" open>
      <summary>
        <span class="section-title">${escapeHtml(title)}</span>
        <span class="section-summary">${renderBadge(status)} ${escapeHtml(summary)}</span>
      </summary>
      <div class="section-body">${body}</div>
    </details>
  `;
}

function resolveOptionalTarget(result: { target?: string }, fallback: string): string {
  return result.target ?? fallback;
}

function renderHtmlDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f5f5;
        --surface: #ffffff;
        --surface-muted: #fafafa;
        --border: #d4d4d8;
        --text: #111827;
        --muted: #6b7280;
        --pass: #22c55e;
        --warn: #eab308;
        --fail: #ef4444;
        --skip: #6b7280;
        --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: linear-gradient(180deg, #fafafa 0%, #f4f4f5 100%);
        color: var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        line-height: 1.5;
      }

      .container {
        max-width: 1120px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }

      .card,
      .section-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        margin-bottom: 16px;
      }

      .card {
        padding: 20px;
      }

      .header-card h1,
      .card h2 {
        margin: 0 0 10px;
        font-size: 1.25rem;
      }

      .eyebrow {
        margin-bottom: 10px;
        color: var(--muted);
        font-size: 0.78rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .target-line,
      .info-line {
        color: var(--muted);
        overflow-wrap: anywhere;
      }

      .meta-grid,
      .stats-grid,
      .gate-grid,
      .definition-list {
        display: grid;
        gap: 12px;
      }

      .meta-grid,
      .gate-grid,
      .definition-list {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      .stats-grid {
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        margin-top: 16px;
      }

      .meta-grid {
        margin-top: 14px;
      }

      .meta-item,
      .definition-item,
      .stat-card,
      .gate-card {
        background: var(--surface-muted);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px;
      }

      .meta-item,
      .definition-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }

      .meta-label,
      .definition-label,
      .stat-label {
        color: var(--muted);
        font-size: 0.82rem;
      }

      .meta-value,
      .definition-value {
        text-align: right;
        overflow-wrap: anywhere;
      }

      .stat-value {
        margin-top: 4px;
        font-size: 1.3rem;
        font-weight: 700;
      }

      .stat-note {
        margin-top: 6px;
        color: var(--muted);
        font-size: 0.82rem;
      }

      .status-pass {
        border-color: rgba(34, 197, 94, 0.35);
      }

      .status-warn {
        border-color: rgba(234, 179, 8, 0.35);
      }

      .status-fail {
        border-color: rgba(239, 68, 68, 0.35);
      }

      .status-skip {
        border-color: rgba(107, 114, 128, 0.35);
      }

      .row-list {
        display: grid;
        gap: 12px;
      }

      .row {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        background: var(--surface-muted);
      }

      .row-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }

      .row-title {
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .row-subtitle {
        margin-top: 4px;
        color: var(--muted);
        font-size: 0.84rem;
        overflow-wrap: anywhere;
      }

      .row-body {
        margin-top: 10px;
        overflow-wrap: anywhere;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 58px;
        padding: 3px 10px;
        border-radius: 999px;
        border: 1px solid currentColor;
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }

      .badge.pass {
        color: #15803d;
        background: rgba(34, 197, 94, 0.14);
      }

      .badge.warn {
        color: #a16207;
        background: rgba(234, 179, 8, 0.18);
      }

      .badge.fail {
        color: #b91c1c;
        background: rgba(239, 68, 68, 0.14);
      }

      .badge.skip {
        color: #4b5563;
        background: rgba(107, 114, 128, 0.14);
      }

      details {
        margin-top: 10px;
      }

      details summary {
        cursor: pointer;
        color: var(--muted);
      }

      .detail-block {
        border-top: 1px dashed var(--border);
        padding-top: 10px;
      }

      .detail-content p {
        margin: 0;
      }

      .section-card summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 18px 20px;
        list-style: none;
      }

      .section-card summary::-webkit-details-marker {
        display: none;
      }

      .section-title {
        font-size: 1rem;
        font-weight: 700;
        color: var(--text);
      }

      .section-summary {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        text-align: right;
      }

      .section-body {
        padding: 0 20px 20px;
      }

      .gate-grid {
        margin-top: 12px;
      }

      pre {
        margin: 0;
        padding: 12px;
        background: #f8fafc;
        border: 1px solid var(--border);
        border-radius: 10px;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      ul {
        margin: 0;
        padding-left: 20px;
      }

      @media (max-width: 720px) {
        .container {
          padding: 16px 12px 28px;
        }

        .row-header,
        .section-card summary,
        .meta-item,
        .definition-item {
          flex-direction: column;
          align-items: flex-start;
        }

        .meta-value,
        .definition-value,
        .section-summary {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main class="container">
      ${body}
    </main>
  </body>
</html>`;
}

export function renderLintHtml(report: LintReport): string {
  const passRate = report.summary.total === 0 ? 0 : report.summary.passed / report.summary.total;
  const body = [
    renderHeaderCard(
      "lint",
      "Static Analysis Report",
      report.target,
      [
        { label: "Pass rate", value: formatPercent(passRate), note: `${report.summary.passed}/${report.summary.total} passed` },
        { label: "Warnings", value: String(report.summary.warnings), status: report.summary.warnings > 0 ? "warn" : "pass" },
        { label: "Failures", value: String(report.summary.failures), status: report.summary.failures > 0 ? "fail" : "pass" },
        { label: "Checks", value: String(report.summary.total) }
      ],
      [{ label: "Target", value: report.target }]
    ),
    renderSectionCard("Lint Issues", renderLintIssueList(report))
  ].join("");

  return renderHtmlDocument(`skilltest lint - ${report.target}`, body);
}

export function renderTriggerHtml(result: TriggerTestResult): string {
  const htmlResult = result as TriggerTestResult & { target?: string };
  const target = resolveOptionalTarget(htmlResult, result.skillName);
  const matchedCount = result.cases.filter((testCase) => testCase.matched).length;
  const matchRate = result.cases.length === 0 ? 0 : matchedCount / result.cases.length;
  const body = [
    renderHeaderCard(
      "trigger",
      result.skillName,
      target,
      [
        { label: "Match rate", value: formatPercent(matchRate), note: `${matchedCount}/${result.cases.length} matched` },
        { label: "Precision", value: formatPercent(result.metrics.precision) },
        { label: "Recall", value: formatPercent(result.metrics.recall) },
        { label: "F1", value: formatPercent(result.metrics.f1), status: result.metrics.f1 >= 0.8 ? "pass" : "warn" }
      ],
      [
        { label: "Provider", value: result.provider },
        { label: "Model", value: result.model },
        { label: "Seed", value: result.seed !== undefined ? String(result.seed) : "none" },
        { label: "Queries", value: String(result.queries.length) }
      ]
    ),
    renderSectionCard("Trigger Cases", `<div class="row-list">${result.cases.map((testCase) => renderTriggerCaseRow(testCase)).join("")}</div>`),
    renderSectionCard(
      "Suggestions",
      `<ul>${result.suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join("")}</ul>`
    )
  ].join("");

  return renderHtmlDocument(`skilltest trigger - ${result.skillName}`, body);
}

export function renderEvalHtml(result: EvalResult): string {
  const htmlResult = result as EvalResult & { target?: string };
  const target = resolveOptionalTarget(htmlResult, result.skillName);
  const passRate = result.summary.totalAssertions === 0 ? 0 : result.summary.passedAssertions / result.summary.totalAssertions;
  const body = [
    renderHeaderCard(
      "eval",
      result.skillName,
      target,
      [
        {
          label: "Assertion pass rate",
          value: formatPercent(passRate),
          note: `${result.summary.passedAssertions}/${result.summary.totalAssertions} passed`
        },
        { label: "Prompts", value: String(result.summary.totalPrompts) },
        { label: "Model", value: result.model },
        { label: "Grader", value: result.graderModel }
      ],
      [
        { label: "Provider", value: result.provider },
        { label: "Execution model", value: result.model },
        { label: "Grader model", value: result.graderModel },
        { label: "Prompts", value: String(result.prompts.length) }
      ]
    ),
    renderSectionCard("Eval Prompts", `<div class="row-list">${result.results.map((promptResult) => renderEvalPromptRow(promptResult)).join("")}</div>`)
  ].join("");

  return renderHtmlDocument(`skilltest eval - ${result.skillName}`, body);
}

export function renderCheckHtml(result: CheckRunResult): string {
  const skillName = result.trigger?.skillName ?? result.eval?.skillName ?? result.target;
  const triggerBody = result.trigger
    ? `<div class="row-list">${result.trigger.cases.map((testCase) => renderTriggerCaseRow(testCase)).join("")}</div>
       <div class="card" style="margin-top: 16px;">
         <h2>Trigger Suggestions</h2>
         <ul>${result.trigger.suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join("")}</ul>
       </div>`
    : renderMessageRow("skip", "Trigger skipped", result.triggerSkippedReason ?? "Skipped.");

  const evalBody = result.eval
    ? `<div class="row-list">${result.eval.results.map((promptResult) => renderEvalPromptRow(promptResult)).join("")}</div>`
    : renderMessageRow("skip", "Eval skipped", result.evalSkippedReason ?? "Skipped.");

  const lintStatus: HtmlStatus = result.gates.lintPassed ? "pass" : "fail";
  const triggerStatus = gateStatus(result.gates.triggerPassed);
  const evalStatus = gateStatus(result.gates.evalPassed);
  const overallStatus: HtmlStatus = result.gates.overallPassed ? "pass" : "fail";

  const header = renderHeaderCard(
    "check",
    skillName,
    result.target,
    [
      { label: "Overall gate", value: badgeLabel(overallStatus), status: overallStatus },
      {
        label: "Trigger F1",
        value: result.gates.triggerF1 !== null ? formatPercent(result.gates.triggerF1) : "skipped",
        status: triggerStatus
      },
      {
        label: "Eval pass rate",
        value: result.gates.evalAssertPassRate !== null ? formatPercent(result.gates.evalAssertPassRate) : "skipped",
        status: evalStatus
      },
      {
        label: "Lint result",
        value: `${result.lint.summary.failures} fail / ${result.lint.summary.warnings} warn`,
        status: lintStatus
      }
    ],
    [
      { label: "Provider", value: result.provider },
      { label: "Model", value: result.model },
      { label: "Grader model", value: result.graderModel },
      {
        label: "Thresholds",
        value: `min-f1=${result.thresholds.minF1.toFixed(2)} min-assert-pass-rate=${result.thresholds.minAssertPassRate.toFixed(2)}`
      }
    ]
  );

  const lintSection = renderCollapsibleSection(
    "Lint",
    `${result.lint.summary.passed}/${result.lint.summary.total} passed, ${result.lint.summary.warnings} warnings, ${result.lint.summary.failures} failures`,
    renderLintIssueList(result.lint),
    lintStatus
  );

  const triggerSection = renderCollapsibleSection(
    "Trigger",
    result.trigger
      ? `f1=${formatPercent(result.trigger.metrics.f1)} precision=${formatPercent(result.trigger.metrics.precision)} recall=${formatPercent(result.trigger.metrics.recall)}`
      : result.triggerSkippedReason ?? "Skipped.",
    triggerBody,
    triggerStatus
  );

  const evalSection = renderCollapsibleSection(
    "Eval",
    result.eval
      ? `assertion pass rate=${formatPercent(result.gates.evalAssertPassRate ?? 0)} (${result.eval.summary.passedAssertions}/${result.eval.summary.totalAssertions})`
      : result.evalSkippedReason ?? "Skipped.",
    evalBody,
    evalStatus
  );

  const qualityGate = renderSectionCard(
    "Quality Gate",
    `<div class="gate-grid">
      ${renderGateCard("Lint gate", lintStatus, result.gates.lintPassed ? "Lint passed." : "Lint failed.")}
      ${renderGateCard(
        "Trigger gate",
        triggerStatus,
        result.gates.triggerPassed === null
          ? result.triggerSkippedReason ?? "Skipped."
          : `required ${result.thresholds.minF1.toFixed(2)}, actual ${result.gates.triggerF1?.toFixed(2) ?? "n/a"}`
      )}
      ${renderGateCard(
        "Eval gate",
        evalStatus,
        result.gates.evalPassed === null
          ? result.evalSkippedReason ?? "Skipped."
          : `required ${result.thresholds.minAssertPassRate.toFixed(2)}, actual ${result.gates.evalAssertPassRate?.toFixed(2) ?? "n/a"}`
      )}
      ${renderGateCard("Overall", overallStatus, result.gates.overallPassed ? "All quality gates passed." : "One or more gates failed.")}
    </div>`
  );

  return renderHtmlDocument(`skilltest check - ${skillName}`, [header, lintSection, triggerSection, evalSection, qualityGate].join(""));
}
