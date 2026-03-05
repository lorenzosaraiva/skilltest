import { loadSkillFile, parseFrontmatter } from "../skill-parser.js";
import { runCompatibilityChecks } from "./compat.js";
import { LintContext } from "./context.js";
import { runContentChecks } from "./content.js";
import { runDisclosureChecks } from "./disclosure.js";
import { runFrontmatterChecks } from "./frontmatter.js";
import { runSecurityChecks } from "./security.js";
import { runStructureChecks } from "./structure.js";
import { LintIssue, LintReport, LintSummary } from "./types.js";

function summarizeIssues(issues: LintIssue[]): LintSummary {
  const summary: LintSummary = {
    total: issues.length,
    passed: 0,
    warnings: 0,
    failures: 0
  };

  for (const issue of issues) {
    if (issue.status === "pass") {
      summary.passed += 1;
      continue;
    }
    if (issue.status === "warn") {
      summary.warnings += 1;
      continue;
    }
    summary.failures += 1;
  }

  return summary;
}

export async function runLinter(inputPath: string): Promise<LintReport> {
  const skill = await loadSkillFile(inputPath);
  const frontmatter = parseFrontmatter(skill.raw);
  const context: LintContext = {
    skill,
    frontmatter
  };

  const issues: LintIssue[] = [];
  issues.push(...runFrontmatterChecks(context));
  issues.push(...(await runStructureChecks(context)));
  issues.push(...runContentChecks(context));
  issues.push(...runSecurityChecks(context));
  issues.push(...(await runDisclosureChecks(context)));
  issues.push(...runCompatibilityChecks(context));

  return {
    target: inputPath,
    issues,
    summary: summarizeIssues(issues)
  };
}

export type { LintIssue, LintReport, LintSummary } from "./types.js";
