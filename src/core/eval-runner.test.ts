import { describe, expect, it } from "vitest";
import { runEval, evalPromptArraySchema } from "./eval-runner.js";
import type { ParsedSkill } from "./skill-parser.js";
import type { LanguageModelProvider } from "../providers/types.js";

const parsedSkill: ParsedSkill = {
  skillRoot: "/tmp/skill",
  skillFile: "/tmp/skill/SKILL.md",
  raw: "---\nname: checklist-reviewer\ndescription: Reviews deployment checklists.\nlicense: MIT\n---\n# Checklist Reviewer\n",
  content: "# Checklist Reviewer\nInspect the checklist and identify missing items.\n",
  frontmatterRaw: "name: checklist-reviewer\ndescription: Reviews deployment checklists.\nlicense: MIT",
  frontmatter: {
    name: "checklist-reviewer",
    description: "Reviews deployment checklists.",
    license: "MIT"
  }
};

describe("eval prompt schema", () => {
  it("parses prompts with tools and tool assertions", () => {
    expect(() =>
      evalPromptArraySchema.parse([
        {
          prompt: "Review this checklist.",
          assertions: ["response should mention the missing rollback plan"],
          tools: [
            {
              name: "read_file",
              description: "Read a file",
              parameters: [
                {
                  name: "path",
                  type: "string",
                  description: "Path to read",
                  required: true
                }
              ],
              responses: {
                '{"path":"checklist.md"}': "Checklist content",
                "*": "[mock] missing"
              }
            }
          ],
          toolAssertions: [
            {
              type: "tool_called",
              toolName: "read_file",
              description: "The model should read the checklist"
            }
          ]
        }
      ])
    ).not.toThrow();
  });

  it("parses prompts without tools for backward compatibility", () => {
    expect(() =>
      evalPromptArraySchema.parse([
        {
          prompt: "Review this checklist.",
          assertions: ["response should mention the missing rollback plan"]
        }
      ])
    ).not.toThrow();
  });
});

describe("runEval with tools", () => {
  it("records tool calls and loop iterations when a prompt provides mock tools", async () => {
    let sendWithToolsCalls = 0;
    const provider: LanguageModelProvider = {
      name: "anthropic",
      async sendMessage(_systemPrompt, _userMessage, _options) {
        return JSON.stringify({
          assertions: [
            {
              assertion: "response should mention the missing rollback plan",
              passed: true,
              evidence: "The response mentions the rollback plan."
            }
          ]
        });
      },
      async sendWithTools(_systemPrompt, messages, _options) {
        sendWithToolsCalls += 1;

        if (sendWithToolsCalls === 1) {
          expect(messages).toEqual([{ role: "user", content: "Review this checklist." }]);
          return {
            textContent: "",
            toolUseBlocks: [
              {
                id: "tool-1",
                name: "read_file",
                arguments: { path: "checklist.md" }
              }
            ],
            stopReason: "tool_use"
          };
        }

        expect(messages).toEqual([
          { role: "user", content: "Review this checklist." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "checklist.md" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "# Deploy Checklist\n- [ ] Rollback plan"
              }
            ]
          }
        ]);

        return {
          textContent: "The checklist is missing a rollback plan.",
          toolUseBlocks: [],
          stopReason: "end_turn"
        };
      }
    };

    const result = await runEval(parsedSkill, {
      provider,
      model: "test-model",
      graderModel: "test-grader",
      numRuns: 1,
      concurrency: 1,
      prompts: [
        {
          prompt: "Review this checklist.",
          assertions: ["response should mention the missing rollback plan"],
          tools: [
            {
              name: "read_file",
              description: "Read a file",
              parameters: [
                {
                  name: "path",
                  type: "string",
                  description: "Path to read",
                  required: true
                }
              ],
              responses: {
                '{"path":"checklist.md"}': "# Deploy Checklist\n- [ ] Rollback plan",
                "*": "[mock] missing"
              }
            }
          ],
          toolAssertions: [
            {
              type: "tool_called",
              toolName: "read_file",
              description: "The model should read the checklist"
            }
          ]
        }
      ]
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.toolCalls).toEqual([
      {
        name: "read_file",
        arguments: { path: "checklist.md" },
        response: "# Deploy Checklist\n- [ ] Rollback plan",
        turnIndex: 1
      }
    ]);
    expect(result.results[0]?.loopIterations).toBe(2);
    expect(result.results[0]?.passedAssertions).toBe(2);
    expect(result.results[0]?.totalAssertions).toBe(2);
  });
});
