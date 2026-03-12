import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalPrompt } from "./eval-runner.js";
import { runImprove } from "./improver.js";
import { TriggerQuery } from "./trigger-tester.js";
import type { LanguageModelProvider } from "../providers/types.js";

const triggerQueries: TriggerQuery[] = [
  {
    query: "Review this deployment checklist and tell me what is missing before production.",
    should_trigger: true
  },
  {
    query: "Draft release notes for version 1.2.0.",
    should_trigger: false
  }
];

const evalPrompts: EvalPrompt[] = [
  {
    prompt: "Validate this deployment checklist and point out the missing rollback plan.",
    assertions: ["output should mention the missing rollback plan"]
  }
];

const improvedRewrite = {
  frontmatter: {
    description: "Analyzes deployment checklists when the user asks for validation, scoring, or missing release safeguards."
  },
  content: [
    "# Checklist Auditor",
    "",
    "Use this skill when the user asks to validate, score, or audit a deployment checklist.",
    "",
    "## Workflow",
    "",
    "1. Read the checklist and identify missing safeguards, especially any rollback plan.",
    "2. Explain the impact of each missing safeguard.",
    "3. Recommend concrete next steps.",
    "",
    "## Example",
    "",
    "User prompt:",
    "",
    "```text",
    "Validate this deployment checklist and tell me what is missing before production.",
    "```",
    "",
    "Expected behavior:",
    "",
    "```text",
    "Call out any missing rollback plan and recommend remediation.",
    "```"
  ].join("\n"),
  changeSummary: [
    "Rewrote the description with explicit trigger language for deployment checklist validation.",
    "Added workflow steps that require calling out a missing rollback plan.",
    "Added a concrete example to improve clarity."
  ],
  targetedProblems: [
    "False negatives from vague trigger wording.",
    "Eval failures where the response ignored the missing rollback plan.",
    "Lint warnings from missing concrete examples."
  ]
};

const tempDirectories: string[] = [];

async function createTempSkill(skillMarkdown: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skilltest-improver-"));
  tempDirectories.push(directory);
  await fs.writeFile(path.join(directory, "SKILL.md"), skillMarkdown, "utf8");
  return directory;
}

function createProvider(improveResponse: unknown): LanguageModelProvider {
  return {
    name: "anthropic",
    async sendMessage(systemPrompt, userPrompt) {
      if (systemPrompt.includes("You rewrite Agent Skill files")) {
        return typeof improveResponse === "string" ? improveResponse : JSON.stringify(improveResponse);
      }

      if (systemPrompt.includes("You are selecting one skill to activate")) {
        const userQuery = userPrompt.match(/User query:\s*(.*)$/m)?.[1] ?? userPrompt;
        const strongDescription = /deployment checklists|deployment checklist validation/i.test(userPrompt);
        if (/deployment checklist/i.test(userQuery)) {
          return strongDescription ? "checklist-auditor" : "none";
        }
        return "none";
      }

      if (systemPrompt.includes("You are an AI assistant with an activated skill")) {
        return /rollback plan/i.test(systemPrompt)
          ? "The checklist is missing a rollback plan."
          : "The checklist looks fine.";
      }

      if (systemPrompt.includes("You are a strict evaluator for agent skill outputs")) {
        const passed = /Model response:\s*The checklist is missing a rollback plan\./i.test(userPrompt);
        return JSON.stringify({
          assertions: [
            {
              assertion: "output should mention the missing rollback plan",
              passed,
              evidence: passed
                ? "The response explicitly mentions the missing rollback plan."
                : "The response does not mention the missing rollback plan."
            }
          ]
        });
      }

      throw new Error(`Unexpected prompt in test provider: ${systemPrompt}`);
    },
    async sendWithTools() {
      throw new Error("sendWithTools should not be called in improver tests.");
    }
  };
}

const baselineSkill = `---
name: checklist-auditor
description: Helps with stuff.
license: MIT
---

# Checklist Auditor

Review the checklist and respond.
`;

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("runImprove", () => {
  it("rewrites SKILL.md in dry-run mode and verifies improvement on frozen inputs", async () => {
    const skillRoot = await createTempSkill(baselineSkill);
    const result = await runImprove(skillRoot, {
      provider: createProvider(improvedRewrite),
      model: "test-model",
      lintFailOn: "error",
      lintSuppress: [],
      lintPlugins: [],
      numQueries: 2,
      queries: triggerQueries,
      prompts: evalPrompts,
      evalNumRuns: 1,
      evalMaxToolIterations: 5,
      minF1: 0.8,
      minAssertPassRate: 1,
      concurrency: 1
    });

    expect(result.blockedReason).toBeUndefined();
    expect(result.applied).toBe(false);
    expect(result.candidate?.frontmatter.description).toContain("deployment checklists");
    expect(result.baseline.trigger?.queries).toEqual(triggerQueries);
    expect(result.verification?.trigger?.queries).toEqual(triggerQueries);
    expect(result.baseline.eval?.prompts).toEqual(evalPrompts);
    expect(result.verification?.eval?.prompts).toEqual(evalPrompts);
    expect(result.delta?.triggerF1.before).toBe(0);
    expect(result.delta?.triggerF1.after).toBe(1);
    expect(result.delta?.evalAssertPassRate.before).toBe(0);
    expect(result.delta?.evalAssertPassRate.after).toBe(1);
    expect(result.verification?.gates.overallPassed).toBe(true);
    expect(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8")).toBe(baselineSkill);
  });

  it("applies the verified rewrite in place when apply is enabled", async () => {
    const skillRoot = await createTempSkill(baselineSkill);
    const result = await runImprove(skillRoot, {
      provider: createProvider(improvedRewrite),
      model: "test-model",
      lintFailOn: "error",
      lintSuppress: [],
      lintPlugins: [],
      numQueries: 2,
      queries: triggerQueries,
      prompts: evalPrompts,
      evalNumRuns: 1,
      evalMaxToolIterations: 5,
      minF1: 0.8,
      minAssertPassRate: 1,
      concurrency: 1,
      apply: true
    });

    expect(result.blockedReason).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8")).toContain("deployment checklist");
  });

  it("rejects invalid improve JSON", async () => {
    const skillRoot = await createTempSkill(baselineSkill);

    await expect(
      runImprove(skillRoot, {
        provider: createProvider("not json"),
        model: "test-model",
        lintFailOn: "error",
        lintSuppress: [],
        lintPlugins: [],
        numQueries: 2,
        queries: triggerQueries,
        prompts: evalPrompts,
        evalNumRuns: 1,
        evalMaxToolIterations: 5,
        minF1: 0.8,
        minAssertPassRate: 1,
        concurrency: 1
      })
    ).rejects.toThrow(/improver did not return a JSON object/i);
  });

  it("rejects rewrites that break frontmatter validation", async () => {
    const skillRoot = await createTempSkill(baselineSkill);

    await expect(
      runImprove(skillRoot, {
        provider: createProvider({
          ...improvedRewrite,
          frontmatter: {
            description: 42
          }
        }),
        model: "test-model",
        lintFailOn: "error",
        lintSuppress: [],
        lintPlugins: [],
        numQueries: 2,
        queries: triggerQueries,
        prompts: evalPrompts,
        evalNumRuns: 1,
        evalMaxToolIterations: 5,
        minF1: 0.8,
        minAssertPassRate: 1,
        concurrency: 1
      })
    ).rejects.toThrow(/invalid frontmatter field 'description'/i);
  });

  it("rejects rewrites that rename the skill", async () => {
    const skillRoot = await createTempSkill(baselineSkill);

    await expect(
      runImprove(skillRoot, {
        provider: createProvider({
          ...improvedRewrite,
          frontmatter: {
            ...improvedRewrite.frontmatter,
            name: "other-skill"
          }
        }),
        model: "test-model",
        lintFailOn: "error",
        lintSuppress: [],
        lintPlugins: [],
        numQueries: 2,
        queries: triggerQueries,
        prompts: evalPrompts,
        evalNumRuns: 1,
        evalMaxToolIterations: 5,
        minF1: 0.8,
        minAssertPassRate: 1,
        concurrency: 1
      })
    ).rejects.toThrow(/attempted to rename skill/i);
  });

  it("rejects rewrites that introduce broken references", async () => {
    const skillRoot = await createTempSkill(baselineSkill);

    await expect(
      runImprove(skillRoot, {
        provider: createProvider({
          ...improvedRewrite,
          content: `${improvedRewrite.content}\n\nSee [missing guide](references/missing.md).`
        }),
        model: "test-model",
        lintFailOn: "error",
        lintSuppress: [],
        lintPlugins: [],
        numQueries: 2,
        queries: triggerQueries,
        prompts: evalPrompts,
        evalNumRuns: 1,
        evalMaxToolIterations: 5,
        minF1: 0.8,
        minAssertPassRate: 1,
        concurrency: 1
      })
    ).rejects.toThrow(/broken relative reference/i);
  });

  it("blocks rewrites that do not measurably improve the frozen test set", async () => {
    const skillRoot = await createTempSkill(baselineSkill);
    const result = await runImprove(skillRoot, {
      provider: createProvider({
        ...improvedRewrite,
        frontmatter: {
          description: "Helps with miscellaneous tasks."
        },
        content: "# Checklist Auditor\n\nReview the checklist and respond carefully.\n",
        changeSummary: ["Made a superficial wording change."],
        targetedProblems: ["None materially addressed."]
      }),
      model: "test-model",
      lintFailOn: "error",
      lintSuppress: [],
      lintPlugins: [],
      numQueries: 2,
      queries: triggerQueries,
      prompts: evalPrompts,
      evalNumRuns: 1,
      evalMaxToolIterations: 5,
      minF1: 0.8,
      minAssertPassRate: 1,
      concurrency: 1
    });

    expect(result.blockedReason).toMatch(/did not produce a measurable improvement/i);
    expect(result.applied).toBe(false);
    expect(result.verification).not.toBeNull();
  });
});
