import { describe, expect, it } from "vitest";
import { buildGraderPrompts, parseGraderOutput } from "./grader.js";

describe("grader helpers", () => {
  it("builds the expected grading prompt structure", () => {
    const prompts = buildGraderPrompts({
      skillName: "repo-auditor",
      skillBody: "# Instructions\nReview the repository and explain findings.",
      userPrompt: "Audit this repository for release blockers.",
      modelResponse: "I found two blockers.",
      assertions: ["Response identifies blockers.", "Response suggests remediation."]
    });

    expect(prompts.systemPrompt).toContain("strict evaluator");
    expect(prompts.userPrompt).toContain("Skill: repo-auditor");
    expect(prompts.userPrompt).toContain("User prompt: Audit this repository for release blockers.");
    expect(prompts.userPrompt).toContain("1. Response identifies blockers.");
    expect(prompts.userPrompt).toContain("2. Response suggests remediation.");
  });

  it("parses a well-formed grader response", () => {
    const assertions = parseGraderOutput(
      'Result:\n{"assertions":[{"assertion":"Response identifies blockers.","passed":true,"evidence":"Mentions two blockers."}]}'
    );

    expect(assertions).toEqual([
      {
        assertion: "Response identifies blockers.",
        passed: true,
        evidence: "Mentions two blockers."
      }
    ]);
  });

  it("throws a readable error for malformed grader JSON", () => {
    expect(() => parseGraderOutput("not json at all")).toThrow(/JSON object/i);
  });
});
