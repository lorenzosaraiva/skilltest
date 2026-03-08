import { describe, expect, it } from "vitest";
import type { ParsedSkill } from "./skill-parser.js";
import { calculateMetrics, prepareTriggerQueries, validateNumQueries } from "./trigger-tester.js";

const skill = {
  frontmatter: {
    name: "target-skill",
    description: "Analyze repositories when a user asks for validation or troubleshooting guidance."
  }
} as Pick<ParsedSkill, "frontmatter">;

describe("trigger tester helpers", () => {
  it("produces the same fake-skill set for the same seed", () => {
    const queries = [
      { query: "Validate this deployment checklist.", should_trigger: true },
      { query: "Write a database migration.", should_trigger: false }
    ];

    const first = prepareTriggerQueries(skill, queries, 123);
    const second = prepareTriggerQueries(skill, queries, 123);

    expect(first).toEqual(second);
  });

  it("validates that numQueries is even", () => {
    expect(validateNumQueries(4)).toBe(4);
    expect(() => validateNumQueries(3)).toThrow(/even number/i);
  });

  it("calculates precision, recall, and f1 from known counts", () => {
    const metrics = calculateMetrics("target-skill", [
      { query: "q1", shouldTrigger: true, expected: "target-skill", actual: "target-skill", matched: true },
      { query: "q2", shouldTrigger: true, expected: "target-skill", actual: "target-skill", matched: true },
      { query: "q3", shouldTrigger: true, expected: "target-skill", actual: "none", matched: false },
      { query: "q4", shouldTrigger: false, expected: "none", actual: "target-skill", matched: false },
      { query: "q5", shouldTrigger: false, expected: "none", actual: "none", matched: true }
    ]);

    expect(metrics.truePositives).toBe(2);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.trueNegatives).toBe(1);
    expect(metrics.precision).toBeCloseTo(2 / 3, 8);
    expect(metrics.recall).toBeCloseTo(2 / 3, 8);
    expect(metrics.f1).toBeCloseTo(2 / 3, 8);
  });
});
