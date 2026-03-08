import path from "node:path";
import { loadSkillFile, parseFrontmatter } from "../skill-parser.js";
import type { LintContext } from "./context.js";
import type { LintIssue } from "./types.js";

export function createLintContext(
  raw: string,
  options: {
    skillRoot?: string;
    suppressedCheckIds?: string[];
  } = {}
): LintContext {
  const skillRoot = options.skillRoot ?? path.resolve(process.cwd(), "test-fixtures", "invalid-skill");
  const lineCount = raw === "" ? 0 : raw.split(/\r?\n/).length;

  return {
    skill: {
      skillRoot,
      skillFile: path.join(skillRoot, "SKILL.md"),
      raw,
      lineCount
    },
    frontmatter: parseFrontmatter(raw),
    suppressedCheckIds: new Set(options.suppressedCheckIds ?? [])
  };
}

export async function loadFixtureContext(fixturePath: string): Promise<LintContext> {
  const resolvedPath = path.resolve(process.cwd(), fixturePath);
  const skill = await loadSkillFile(resolvedPath);

  return {
    skill,
    frontmatter: parseFrontmatter(skill.raw),
    suppressedCheckIds: new Set()
  };
}

export function findIssue(issues: LintIssue[], key: string): LintIssue {
  const issue = issues.find((item) => item.id === key || item.checkId === key);
  if (!issue) {
    throw new Error(`Issue not found for key: ${key}`);
  }
  return issue;
}
