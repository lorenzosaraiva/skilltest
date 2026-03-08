import { describe, expect, it } from "vitest";
import { runStructureChecks } from "./structure.js";
import { createLintContext, findIssue, loadFixtureContext } from "./test-utils.js";

function buildOversizedSkill(): string {
  const bodyLines = Array.from({ length: 501 }, (_, index) => `Detail line ${index + 1}`);

  return [
    "---",
    "name: oversized-structure-skill",
    "description: Analyze repositories when a user asks for long-form structure validation.",
    "license: MIT",
    "---",
    "",
    ...bodyLines
  ].join("\n");
}

describe("runStructureChecks", () => {
  it("warns when SKILL.md exceeds 500 lines", async () => {
    const issues = await runStructureChecks(createLintContext(buildOversizedSkill()));

    expect(findIssue(issues, "structure:file-size").status).toBe("warn");
  });

  it("fails when referenced scripts, references, and assets are missing", async () => {
    const issues = await runStructureChecks(await loadFixtureContext("test-fixtures/linter/broken-skill"));

    expect(findIssue(issues, "structure.scripts.exists").status).toBe("fail");
    expect(findIssue(issues, "structure.references.exists").status).toBe("fail");
    expect(findIssue(issues, "structure.assets.exists").status).toBe("fail");
  });

  it("passes when referenced files exist", async () => {
    const issues = await runStructureChecks(await loadFixtureContext("test-fixtures/sample-skill"));

    expect(findIssue(issues, "structure.scripts.exists").status).toBe("pass");
    expect(findIssue(issues, "structure.references.exists").status).toBe("pass");
    expect(findIssue(issues, "structure.assets.exists").status).toBe("pass");
    expect(findIssue(issues, "structure.relative-links.broken").status).toBe("pass");
  });
});
