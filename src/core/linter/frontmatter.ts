import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function getStringField(data: Record<string, unknown> | null, key: string): string | null {
  if (!data) {
    return null;
  }
  const value = data[key];
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

function descriptionLooksActionable(description: string): boolean {
  const whatPattern =
    /\b(create|build|generate|analyze|test|validate|review|refactor|debug|audit|compose|transform|summari[sz]e|plan)\b/i;
  const whenPattern = /\b(when|if|for|whenever|use this|ideal for|best for|should use)\b/i;
  return whatPattern.test(description) && whenPattern.test(description);
}

export function runFrontmatterChecks(context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];

  if (!context.frontmatter.hasFrontmatter) {
    issues.push({
      id: "frontmatter.exists",
      title: "Frontmatter Presence",
      status: "fail",
      message: "SKILL.md is missing YAML frontmatter delimited by --- blocks.",
      suggestion: "Add YAML frontmatter at the top with at least name and description."
    });
    return issues;
  }

  if (context.frontmatter.error) {
    issues.push({
      id: "frontmatter.valid-yaml",
      title: "Frontmatter YAML",
      status: "fail",
      message: `Frontmatter is not valid YAML: ${context.frontmatter.error}`,
      suggestion: "Fix YAML syntax so the frontmatter parses as an object."
    });
    return issues;
  }

  issues.push({
    id: "frontmatter.valid-yaml",
    title: "Frontmatter YAML",
    status: "pass",
    message: "Frontmatter exists and parses correctly."
  });

  const data = context.frontmatter.data ?? {};
  const name = getStringField(data, "name");
  if (!name) {
    issues.push({
      id: "frontmatter.name.required",
      title: "Frontmatter Name",
      status: "fail",
      message: "Missing required frontmatter field: name.",
      suggestion: "Set name to lowercase words separated by single hyphens."
    });
  } else if (name.length > 64) {
    issues.push({
      id: "frontmatter.name.length",
      title: "Frontmatter Name Length",
      status: "fail",
      message: `name is too long (${name.length} chars, max 64).`,
      suggestion: "Shorten the skill name to 64 characters or fewer."
    });
  } else if (!SKILL_NAME_REGEX.test(name)) {
    issues.push({
      id: "frontmatter.name.format",
      title: "Frontmatter Name Format",
      status: "fail",
      message: "name must be lowercase alphanumeric with single hyphen separators only.",
      suggestion: "Use format like 'api-tester' or 'code-review'."
    });
  } else {
    issues.push({
      id: "frontmatter.name.valid",
      title: "Frontmatter Name",
      status: "pass",
      message: "name is present and follows naming conventions."
    });
  }

  const description = getStringField(data, "description");
  if (!description || description.trim() === "") {
    issues.push({
      id: "frontmatter.description.required",
      title: "Frontmatter Description",
      status: "fail",
      message: "Missing required frontmatter field: description.",
      suggestion: "Add a clear description of what the skill does and when to use it."
    });
  } else if (description.length > 1024) {
    issues.push({
      id: "frontmatter.description.length",
      title: "Frontmatter Description Length",
      status: "fail",
      message: `description is too long (${description.length} chars, max 1024).`,
      suggestion: "Keep description concise while still specific."
    });
  } else {
    issues.push({
      id: "frontmatter.description.valid",
      title: "Frontmatter Description",
      status: "pass",
      message: "description is present and within allowed length."
    });
  }

  const license = getStringField(data, "license");
  if (!license || license.trim() === "") {
    issues.push({
      id: "frontmatter.license.recommended",
      title: "Frontmatter License",
      status: "warn",
      message: "No license field found in frontmatter.",
      suggestion: "Add a license (for example: MIT) to clarify reuse terms."
    });
  } else {
    issues.push({
      id: "frontmatter.license.present",
      title: "Frontmatter License",
      status: "pass",
      message: "license field is present."
    });
  }

  if (description && description.trim() !== "" && !descriptionLooksActionable(description)) {
    issues.push({
      id: "frontmatter.description.triggerability",
      title: "Description Trigger Clarity",
      status: "warn",
      message: "Description should explain both what the skill does and when it should be used.",
      suggestion: "Include explicit 'use when...' language plus concrete capability wording."
    });
  } else if (description) {
    issues.push({
      id: "frontmatter.description.triggerability",
      title: "Description Trigger Clarity",
      status: "pass",
      message: "Description appears to cover both capability and usage context."
    });
  }

  return issues;
}
