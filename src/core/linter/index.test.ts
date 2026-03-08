import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLinter } from "./index.js";

describe("runLinter", () => {
  it("passes sample-skill with zero failures", async () => {
    const report = await runLinter(path.resolve(process.cwd(), "test-fixtures/sample-skill"));

    expect(report.summary.failures).toBe(0);
    expect(report.summary.warnings).toBe(0);
  });

  it("reports expected failures for a broken fixture", async () => {
    const report = await runLinter(path.resolve(process.cwd(), "test-fixtures/linter/broken-skill"));

    expect(report.summary.failures).toBeGreaterThan(0);
    expect(report.issues.some((issue) => issue.id === "structure.scripts.exists" && issue.status === "fail")).toBe(true);
    expect(report.issues.some((issue) => issue.id === "structure.references.exists" && issue.status === "fail")).toBe(true);
    expect(report.issues.some((issue) => issue.id === "structure.assets.exists" && issue.status === "fail")).toBe(true);
    expect(report.issues.some((issue) => issue.id === "security.dangerous-command-patterns" && issue.status === "fail")).toBe(
      true
    );
    expect(report.issues.some((issue) => issue.id === "security.exfiltration-patterns" && issue.status === "fail")).toBe(true);
  });
});
