import { describe, expect, it } from "vitest";
import { runFrontmatterChecks } from "./frontmatter.js";
import { createLintContext, findIssue } from "./test-utils.js";

function buildSkill(frontmatterLines: string[]): string {
  return ["---", ...frontmatterLines, "---", "", "# Skill", "Use this skill carefully."].join("\n");
}

describe("runFrontmatterChecks", () => {
  it("passes valid frontmatter", () => {
    const issues = runFrontmatterChecks(
      createLintContext(
        buildSkill([
          "name: valid-skill",
          "description: Analyze repositories when a user asks for validation or troubleshooting guidance.",
          "license: MIT"
        ])
      )
    );

    expect(findIssue(issues, "frontmatter:yaml").status).toBe("pass");
    expect(findIssue(issues, "frontmatter:name").status).toBe("pass");
    expect(findIssue(issues, "frontmatter:description").status).toBe("pass");
    expect(findIssue(issues, "frontmatter:license").status).toBe("pass");
    expect(findIssue(issues, "frontmatter:angle-brackets").status).toBe("pass");
    expect(findIssue(issues, "frontmatter:triggerability").status).toBe("pass");
  });

  it("fails when name and description are missing", () => {
    const issues = runFrontmatterChecks(createLintContext(buildSkill(["license: MIT"])));

    expect(findIssue(issues, "frontmatter:name").status).toBe("fail");
    expect(findIssue(issues, "frontmatter:description").status).toBe("fail");
  });

  it("fails when name exceeds 64 characters", () => {
    const issues = runFrontmatterChecks(
      createLintContext(
        buildSkill([
          `name: ${"a".repeat(65)}`,
          "description: Analyze repositories when a user asks for validation or troubleshooting guidance.",
          "license: MIT"
        ])
      )
    );

    expect(findIssue(issues, "frontmatter:name").id).toBe("frontmatter.name.length");
    expect(findIssue(issues, "frontmatter:name").status).toBe("fail");
  });

  it("fails when name contains invalid characters", () => {
    const issues = runFrontmatterChecks(
      createLintContext(
        buildSkill([
          "name: Invalid_Name",
          "description: Analyze repositories when a user asks for validation or troubleshooting guidance.",
          "license: MIT"
        ])
      )
    );

    expect(findIssue(issues, "frontmatter:name").id).toBe("frontmatter.name.format");
    expect(findIssue(issues, "frontmatter:name").status).toBe("fail");
  });

  it("warns when license is missing", () => {
    const issues = runFrontmatterChecks(
      createLintContext(
        buildSkill([
          "name: missing-license",
          "description: Analyze repositories when a user asks for validation or troubleshooting guidance."
        ])
      )
    );

    expect(findIssue(issues, "frontmatter:license").status).toBe("warn");
  });

  it("warns when frontmatter contains angle brackets", () => {
    const issues = runFrontmatterChecks(
      createLintContext(
        buildSkill([
          "name: angle-brackets",
          "description: Analyze <repo> state when a user asks for validation or troubleshooting guidance.",
          "license: MIT"
        ])
      )
    );

    expect(findIssue(issues, "frontmatter:angle-brackets").status).toBe("warn");
  });
});
