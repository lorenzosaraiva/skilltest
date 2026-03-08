import { describe, expect, it } from "vitest";
import { runCompatibilityChecks } from "./compat.js";
import { createLintContext, findIssue } from "./test-utils.js";

function buildSkill(frontmatterLines: string[], body: string): string {
  return ["---", ...frontmatterLines, "---", "", body].join("\n");
}

describe("runCompatibilityChecks", () => {
  it("passes for provider-neutral content", () => {
    const issues = runCompatibilityChecks(
      createLintContext(
        buildSkill(
          [
            "name: compat-skill",
            "description: Analyze repositories when a user asks for validation or troubleshooting guidance.",
            "license: MIT"
          ],
          "# Overview\nUse this skill when a user asks for repository validation."
        )
      )
    );

    expect(findIssue(issues, "compat:frontmatter").status).toBe("pass");
    expect(findIssue(issues, "compat:provider-language").status).toBe("pass");
    expect(findIssue(issues, "compat:summary").status).toBe("pass");
  });

  it("warns on provider-specific allowed-tools frontmatter", () => {
    const issues = runCompatibilityChecks(
      createLintContext(
        buildSkill(
          [
            "name: compat-skill",
            "description: Analyze repositories when a user asks for validation or troubleshooting guidance.",
            "license: MIT",
            "allowed-tools:",
            "  - bash"
          ],
          "# Overview\nUse this skill when a user asks for repository validation."
        )
      )
    );

    expect(findIssue(issues, "compat:frontmatter").status).toBe("warn");
    expect(findIssue(issues, "compat:summary").status).toBe("warn");
  });

  it("warns on provider-specific body language", () => {
    const issues = runCompatibilityChecks(
      createLintContext(
        buildSkill(
          [
            "name: compat-skill",
            "description: Analyze repositories when a user asks for validation or troubleshooting guidance.",
            "license: MIT"
          ],
          "# Overview\nThis skill is tuned for Claude Code workflows only."
        )
      )
    );

    expect(findIssue(issues, "compat:provider-language").status).toBe("warn");
    expect(findIssue(issues, "compat:summary").status).toBe("warn");
  });
});
