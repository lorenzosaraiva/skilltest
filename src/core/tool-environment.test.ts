import { describe, expect, it } from "vitest";
import { evaluateToolAssertions } from "./eval-runner.js";
import {
  MockToolDefinition,
  resolveToolResponse,
  toProviderToolDefinitions,
  ToolCall
} from "./tool-environment.js";

describe("tool environment helpers", () => {
  it("resolves an exact mock tool response match", () => {
    const tool: MockToolDefinition = {
      name: "read_file",
      description: "Read a file",
      responses: {
        '{"path":"a.txt"}': "content"
      }
    };

    expect(resolveToolResponse(tool, { path: "a.txt" })).toBe("content");
  });

  it("falls back to a wildcard mock response", () => {
    const tool: MockToolDefinition = {
      name: "run_script",
      description: "Run a script",
      responses: {
        "*": "default"
      }
    };

    expect(resolveToolResponse(tool, { command: "echo hi" })).toBe("default");
  });

  it("uses the most specific partial mock response match", () => {
    const tool: MockToolDefinition = {
      name: "read_file",
      description: "Read a file",
      responses: {
        '{"path":"a.txt"}': "matched",
        "*": "fallback"
      }
    };

    expect(resolveToolResponse(tool, { path: "a.txt", encoding: "utf8" })).toBe("matched");
  });

  it("returns a fallback string when no mock response matches", () => {
    const tool: MockToolDefinition = {
      name: "read_file",
      description: "Read a file",
      responses: {}
    };

    expect(resolveToolResponse(tool, { path: "missing.txt" })).toContain("No mock response configured for tool 'read_file'");
  });

  it("converts mock tools to provider tool definitions", () => {
    expect(
      toProviderToolDefinitions([
        {
          name: "read_file",
          description: "Read a file",
          parameters: [
            {
              name: "path",
              type: "string",
              description: "File path",
              required: true
            }
          ],
          responses: {
            "*": "ok"
          }
        }
      ])
    ).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path"
            }
          },
          required: ["path"]
        }
      }
    ]);
  });
});

describe("tool assertion evaluation", () => {
  const toolCalls: ToolCall[] = [
    {
      name: "read_file",
      arguments: { path: "checklist.md" },
      response: "Checklist contents",
      turnIndex: 1
    },
    {
      name: "run_script",
      arguments: { command: "./check.sh", retries: 1 },
      response: "Script completed",
      turnIndex: 2
    }
  ];

  it("passes tool_called when the tool was called", () => {
    const [result] = evaluateToolAssertions(
      [{ type: "tool_called", toolName: "read_file", description: "Should read the checklist" }],
      toolCalls
    );

    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("was called 1 time");
  });

  it("fails tool_called when the tool was not called", () => {
    const [result] = evaluateToolAssertions(
      [{ type: "tool_called", toolName: "delete_file", description: "Should delete a file" }],
      toolCalls
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("was not called");
  });

  it("passes tool_not_called when the tool was not called", () => {
    const [result] = evaluateToolAssertions(
      [{ type: "tool_not_called", toolName: "delete_file", description: "Should not delete files" }],
      toolCalls
    );

    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("was not called");
  });

  it("fails tool_not_called when the tool was called", () => {
    const [result] = evaluateToolAssertions(
      [{ type: "tool_not_called", toolName: "read_file", description: "Should not read files" }],
      toolCalls
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("was called 1 time");
  });

  it("passes tool_call_order when tools appear in the expected order", () => {
    const [result] = evaluateToolAssertions(
      [
        {
          type: "tool_call_order",
          toolNames: ["read_file", "run_script"],
          description: "Should read before running the script"
        }
      ],
      toolCalls
    );

    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("[read_file, run_script]");
  });

  it("fails tool_call_order when tools appear in the wrong order", () => {
    const [result] = evaluateToolAssertions(
      [
        {
          type: "tool_call_order",
          toolNames: ["run_script", "read_file"],
          description: "Should run before reading"
        }
      ],
      toolCalls
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("Expected call order [run_script, read_file]");
  });

  it("passes tool_argument_match when a call contains the expected argument subset", () => {
    const [result] = evaluateToolAssertions(
      [
        {
          type: "tool_argument_match",
          toolName: "run_script",
          expectedArgs: { command: "./check.sh" },
          description: "Should run the checklist script"
        }
      ],
      toolCalls
    );

    expect(result.passed).toBe(true);
    expect(result.evidence).toContain('matching {"command":"./check.sh"}');
  });

  it("fails tool_argument_match when no call matches the expected arguments", () => {
    const [result] = evaluateToolAssertions(
      [
        {
          type: "tool_argument_match",
          toolName: "read_file",
          expectedArgs: { path: "other.md" },
          description: "Should read a different file"
        }
      ],
      toolCalls
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('No \'read_file\' call matched {"path":"other.md"}');
  });
});
