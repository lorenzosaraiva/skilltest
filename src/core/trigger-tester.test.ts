import { describe, expect, it } from "vitest";
import type { ParsedSkill } from "./skill-parser.js";
import type { CompetitorSkill } from "./trigger-tester.js";
import {
  assertCompetitorNamesDistinct,
  buildTriggerCaseResult,
  calculateMetrics,
  prepareTriggerQueries,
  validateNumQueries
} from "./trigger-tester.js";

const skill = {
  frontmatter: {
    name: "target-skill",
    description: "Analyze repositories when a user asks for validation or troubleshooting guidance."
  }
} as Pick<ParsedSkill, "frontmatter">;

const competitors: CompetitorSkill[] = [
  {
    name: "security-review",
    description: "Reviews code for security vulnerabilities specifically.",
    sourcePath: "/tmp/security-review"
  },
  {
    name: "performance-review",
    description: "Reviews code for performance issues specifically.",
    sourcePath: "/tmp/performance-review"
  }
];

describe("trigger tester helpers", () => {
  it("keeps standard fake-skill behavior unchanged when no competitors are provided", () => {
    const queries = [
      { query: "Validate this deployment checklist.", should_trigger: true },
      { query: "Write a database migration.", should_trigger: false }
    ];

    const prepared = prepareTriggerQueries(skill, queries, 123);
    const preparedAgain = prepareTriggerQueries(skill, queries, 123);
    const positive = prepared[0];
    const negative = prepared[1];

    expect(prepared).toEqual(preparedAgain);
    expect(positive?.allSkills.some((entry) => entry.name === skill.frontmatter.name)).toBe(true);
    expect(negative?.allSkills.some((entry) => entry.name === skill.frontmatter.name)).toBe(true);
    expect(positive?.fakeSkills.length).toBeGreaterThanOrEqual(5);
    expect(positive?.fakeSkills.length).toBeLessThanOrEqual(9);
    expect(negative?.fakeSkills.length).toBeGreaterThanOrEqual(5);
    expect(negative?.fakeSkills.length).toBeLessThanOrEqual(9);
  });

  it("includes all competitors and reduces fake skill count in comparative mode", () => {
    const queries = [
      { query: "Review this change for security issues.", should_trigger: true },
      { query: "Review this change for performance regressions.", should_trigger: false }
    ];

    const prepared = prepareTriggerQueries(skill, queries, 123, competitors);
    const positive = prepared[0];
    const negative = prepared[1];

    expect(positive?.allSkills.some((entry) => entry.name === skill.frontmatter.name)).toBe(true);
    expect(positive?.allSkills.filter((entry) => competitors.some((competitor) => competitor.name === entry.name))).toHaveLength(
      competitors.length
    );
    expect(positive?.fakeSkills.length).toBeGreaterThanOrEqual(2);
    expect(positive?.fakeSkills.length).toBeLessThanOrEqual(4);

    expect(negative?.allSkills.some((entry) => entry.name === skill.frontmatter.name)).toBe(false);
    expect(negative?.allSkills.filter((entry) => competitors.some((competitor) => competitor.name === entry.name))).toHaveLength(
      competitors.length
    );
    expect(negative?.fakeSkills.length).toBeGreaterThanOrEqual(3);
    expect(negative?.fakeSkills.length).toBeLessThanOrEqual(5);
  });

  it("preserves seed determinism with competitors present", () => {
    const queries = [
      { query: "Validate this deployment checklist.", should_trigger: true },
      { query: "Write a database migration.", should_trigger: false }
    ];

    const first = prepareTriggerQueries(skill, queries, 123, competitors);
    const second = prepareTriggerQueries(skill, queries, 123, competitors);

    expect(first).toEqual(second);
  });

  it("validates that numQueries is even", () => {
    expect(validateNumQueries(4)).toBe(4);
    expect(() => validateNumQueries(3)).toThrow(/even number/i);
  });

  it("throws when a competitor has the same name as the target skill", () => {
    expect(() =>
      assertCompetitorNamesDistinct(skill.frontmatter.name, [
        ...competitors,
        {
          name: "target-skill",
          description: "Conflicting competitor",
          sourcePath: "/tmp/conflict"
        }
      ])
    ).toThrow(/same name as the skill under test/i);
  });

  it("marks the selected competitor when a competitor name is chosen", () => {
    const testCase = buildTriggerCaseResult({
      testQuery: { query: "Review this for security issues.", should_trigger: true },
      skillName: "target-skill",
      decision: "security-review",
      competitorNames: competitors.map((competitor) => competitor.name)
    });

    expect(testCase.actual).toBe("security-review");
    expect(testCase.selectedCompetitor).toBe("security-review");
    expect(testCase.matched).toBe(false);
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
