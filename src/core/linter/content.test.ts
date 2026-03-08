import { describe, expect, it } from "vitest";
import { runContentChecks } from "./content.js";
import { createLintContext, findIssue } from "./test-utils.js";

function buildSkill(body: string, description = "Analyze repositories when a user asks for validation or troubleshooting guidance."): string {
  return ["---", "name: content-skill", `description: ${description}`, "license: MIT", "---", "", body].join("\n");
}

describe("runContentChecks", () => {
  it("passes on well-structured content", () => {
    const body = [
      "# Overview",
      "Use this skill when a user needs repository validation.",
      "## Workflow",
      "1. Review the request scope.",
      "2. Check the relevant files.",
      "3. Summarize the findings clearly.",
      "## Example",
      "Example request: Review this release checklist for missing steps.",
      "Expected output: A concise validation report with remediation guidance.",
      "## Notes",
      "Keep the response concrete and actionable."
    ].join("\n");

    const issues = runContentChecks(createLintContext(buildSkill(body)));

    expect(findIssue(issues, "content:headers").status).toBe("pass");
    expect(findIssue(issues, "content:examples").status).toBe("pass");
    expect(findIssue(issues, "content:vagueness").status).toBe("pass");
    expect(findIssue(issues, "content:secrets").status).toBe("pass");
    expect(findIssue(issues, "content:body-length").status).toBe("pass");
    expect(findIssue(issues, "content:description-length").status).toBe("pass");
  });

  it("warns when the body has no headers", () => {
    const body = [
      "Use this skill when a user needs repository validation.",
      "Review the request scope and summarize findings.",
      "Add concrete remediation guidance."
    ].join("\n");

    const issues = runContentChecks(createLintContext(buildSkill(body)));

    expect(findIssue(issues, "content:headers").status).toBe("warn");
  });

  it("warns when the body has no examples", () => {
    const body = ["# Overview", "Use this skill when a user needs repository validation.", "## Workflow", "Follow the checklist."].join(
      "\n"
    );

    const issues = runContentChecks(createLintContext(buildSkill(body)));

    expect(findIssue(issues, "content:examples").status).toBe("warn");
  });

  it("warns on vague phrases", () => {
    const body = ["# Overview", "Handle as needed when reviewing the repository.", "## Example", "Example request: Validate this repo."].join(
      "\n"
    );

    const issues = runContentChecks(createLintContext(buildSkill(body)));

    expect(findIssue(issues, "content:vagueness").status).toBe("warn");
  });

  it("fails on secret patterns in prose", () => {
    const body = [
      "# Overview",
      "Use this key during validation: sk-1234567890123456789012345",
      "## Example",
      "Example request: Validate this repo."
    ].join("\n");

    const issues = runContentChecks(createLintContext(buildSkill(body)));

    expect(findIssue(issues, "content:secrets").status).toBe("fail");
  });

  it("warns when the body is too short", () => {
    const issues = runContentChecks(createLintContext(buildSkill("# Overview\nToo short.")));

    expect(findIssue(issues, "content:body-length").status).toBe("warn");
  });

  it("warns when the description is too short", () => {
    const body = [
      "# Overview",
      "Use this skill when a user needs repository validation.",
      "## Example",
      "Example request: Validate this repo."
    ].join("\n");

    const issues = runContentChecks(createLintContext(buildSkill(body, "Short description.")));

    expect(findIssue(issues, "content:description-length").status).toBe("warn");
  });
});
