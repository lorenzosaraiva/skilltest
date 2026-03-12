import {
  ConversationBlock,
  LanguageModelProvider,
  ToolDefinition,
  ToolUseBlock
} from "../providers/types.js";

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
}

export interface MockToolDefinition {
  name: string;
  description: string;
  parameters?: ToolParameter[];
  responses: Record<string, string>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  response: string;
  turnIndex: number;
}

export interface ToolEnvironmentResult {
  finalResponse: string;
  toolCalls: ToolCall[];
  loopIterations: number;
}

export interface RunWithToolsOptions {
  provider: LanguageModelProvider;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools: MockToolDefinition[];
  maxIterations?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }

  return left === right;
}

export function matchesArgumentSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }

    return expected.every((value, index) => matchesArgumentSubset(actual[index], value));
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }

    return Object.entries(expected).every(([key, value]) => matchesArgumentSubset(actual[key], value));
  }

  return deepEqual(actual, expected);
}

function parseResponsePattern(pattern: string): Record<string, unknown> | null {
  if (pattern === "*") {
    return null;
  }

  try {
    const parsed = JSON.parse(pattern) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function renderFallbackResponse(tool: MockToolDefinition, args: Record<string, unknown>): string {
  return `[mock] No mock response configured for tool '${tool.name}' with arguments: ${JSON.stringify(args)}`;
}

export function resolveToolResponse(tool: MockToolDefinition, args: Record<string, unknown>): string {
  const exactMatchKey = JSON.stringify(args);
  const exactMatch = tool.responses[exactMatchKey];
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  let bestPartialMatch: { specificity: number; response: string } | null = null;
  for (const [pattern, response] of Object.entries(tool.responses)) {
    if (pattern === "*") {
      continue;
    }

    const parsedPattern = parseResponsePattern(pattern);
    if (!parsedPattern) {
      continue;
    }

    if (!matchesArgumentSubset(args, parsedPattern)) {
      continue;
    }

    const specificity = Object.keys(parsedPattern).length;
    if (!bestPartialMatch || specificity > bestPartialMatch.specificity) {
      bestPartialMatch = { specificity, response };
    }
  }

  if (bestPartialMatch) {
    return bestPartialMatch.response;
  }

  const wildcardMatch = tool.responses["*"];
  if (wildcardMatch !== undefined) {
    return wildcardMatch;
  }

  return renderFallbackResponse(tool, args);
}

export function toProviderToolDefinitions(mockTools: MockToolDefinition[]): ToolDefinition[] {
  return mockTools.map((tool) => {
    const parameters = tool.parameters ?? [];
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          parameters.map((parameter) => [
            parameter.name,
            {
              type: parameter.type,
              description: parameter.description
            }
          ])
        ),
        required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name)
      }
    };
  });
}

function toAssistantConversationBlocks(response: { textContent: string; toolUseBlocks: ToolUseBlock[] }): ConversationBlock[] {
  const contentBlocks = [];

  if (response.textContent.trim().length > 0) {
    contentBlocks.push({
      type: "text",
      text: response.textContent
    });
  }

  for (const block of response.toolUseBlocks) {
    contentBlocks.push({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.arguments
    });
  }

  return contentBlocks.length === 0
    ? []
    : [
        {
          role: "assistant" as const,
          content: contentBlocks
        }
      ];
}

export async function runWithTools(options: RunWithToolsOptions): Promise<ToolEnvironmentResult> {
  const maxIterations = options.maxIterations ?? 10;
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const providerTools = toProviderToolDefinitions(options.tools);
  const messages: ConversationBlock[] = [{ role: "user", content: options.userMessage }];
  const toolCalls: ToolCall[] = [];
  let finalResponse = "";
  let loopIterations = 0;

  while (loopIterations < maxIterations) {
    loopIterations += 1;

    const response = await options.provider.sendWithTools(options.systemPrompt, messages, {
      model: options.model,
      tools: providerTools
    });

    if (response.textContent.trim().length > 0) {
      finalResponse = response.textContent;
    }

    if (response.toolUseBlocks.length === 0) {
      return {
        finalResponse,
        toolCalls,
        loopIterations
      };
    }

    messages.push(...toAssistantConversationBlocks(response));

    const toolResultBlocks = [];
    for (const toolUse of response.toolUseBlocks) {
      const tool = toolsByName.get(toolUse.name);
      const resolvedResponse = tool
        ? resolveToolResponse(tool, toolUse.arguments)
        : `[mock] No tool named '${toolUse.name}' is registered.`;

      toolCalls.push({
        name: toolUse.name,
        arguments: toolUse.arguments,
        response: resolvedResponse,
        turnIndex: loopIterations
      });

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resolvedResponse
      });
    }

    messages.push({
      role: "user",
      content: toolResultBlocks
    });
  }

  const terminationNote = `[skilltest: tool loop terminated after ${maxIterations} iterations]`;
  finalResponse = finalResponse ? `${finalResponse}\n\n${terminationNote}` : terminationNote;

  return {
    finalResponse,
    toolCalls,
    loopIterations
  };
}
