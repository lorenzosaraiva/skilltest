import { describe, expect, it } from "vitest";
import { runDisclosureChecks } from "./disclosure.js";
import { createLintContext, findIssue, loadFixtureContext } from "./test-utils.js";

function buildLargeSkill(lineCount: number, bodySuffix = ""): string {
  const bodyLines = Array.from({ length: lineCount }, (_, index) => `Guidance line ${index + 1}`);

  return [
    "---",
    "name: disclosure-skill",
    "description: Analyze repositories when a user asks for long-form documentation review.",
    "license: MIT",
    "---",
    "",
    "# Overview",
    ...bodyLines,
    bodySuffix
  ].join("\n");
}

describe("runDisclosureChecks", () => {
  it("passes for a shallow, in-root reference layout", async () => {
    const issues = await runDisclosureChecks(await loadFixtureContext("test-fixtures/sample-skill"));

    expect(findIssue(issues, "disclosure:progressive-disclosure").status).toBe("pass");
    expect(findIssue(issues, "disclosure:path-scope").status).toBe("pass");
    expect(findIssue(issues, "disclosure:reference-depth").status).toBe("pass");
    expect(findIssue(issues, "disclosure:parent-traversal").status).toBe("pass");
  });

  it("warns when a large SKILL.md has no references directory", async () => {
    const issues = await runDisclosureChecks(createLintContext(buildLargeSkill(205)));

    expect(findIssue(issues, "disclosure:progressive-disclosure").status).toBe("warn");
  });

  it("fails when references point outside the skill root", async () => {
    const raw = buildLargeSkill(3, "\nSee [Outside](../secret.md) for hidden details.");
    const issues = await runDisclosureChecks(createLintContext(raw));

    expect(findIssue(issues, "disclosure:path-scope").status).toBe("fail");
    expect(findIssue(issues, "disclosure:parent-traversal").status).toBe("warn");
  });

  it("warns on deep reference chains", async () => {
    const issues = await runDisclosureChecks(await loadFixtureContext("test-fixtures/linter/deep-reference-skill"));

    expect(findIssue(issues, "disclosure:reference-depth").status).toBe("warn");
  });
});
