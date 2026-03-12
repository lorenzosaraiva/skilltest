import { z } from "zod";
import { gradeResponse, GradedAssertion } from "./grader.js";
import { ParsedSkill } from "./skill-parser.js";
import { LanguageModelProvider } from "../providers/types.js";
import { pMap } from "../utils/concurrency.js";
import {
  matchesArgumentSubset,
  MockToolDefinition,
  runWithTools,
  ToolCall,
  ToolParameter
} from "./tool-environment.js";

export interface EvalPrompt {
  prompt: string;
  assertions?: string[];
  tools?: MockToolDefinition[];
  toolAssertions?: ToolAssertion[];
}

export interface ToolAssertion {
  type: "tool_called" | "tool_not_called" | "tool_call_order" | "tool_argument_match";
  toolName?: string;
  toolNames?: string[];
  expectedArgs?: Record<string, unknown>;
  description: string;
}

export interface EvalPromptResult {
  prompt: string;
  assertions: GradedAssertion[];
  responseSummary: string;
  response: string;
  passedAssertions: number;
  totalAssertions: number;
  toolCalls?: ToolCall[];
  loopIterations?: number;
}

export interface EvalResultSummary {
  totalPrompts: number;
  totalAssertions: number;
  passedAssertions: number;
}

export interface EvalResult {
  skillName: string;
  model: string;
  graderModel: string;
  provider: string;
  prompts: EvalPrompt[];
  results: EvalPromptResult[];
  summary: EvalResultSummary;
}

const toolParameterSchema: z.ZodType<ToolParameter> = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().min(1),
  required: z.boolean().optional()
});

const mockToolDefinitionSchema: z.ZodType<MockToolDefinition> = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.array(toolParameterSchema).optional(),
  responses: z.record(z.string())
});

const toolAssertionSchema: z.ZodType<ToolAssertion> = z
  .object({
    type: z.enum(["tool_called", "tool_not_called", "tool_call_order", "tool_argument_match"]),
    toolName: z.string().min(1).optional(),
    toolNames: z.array(z.string().min(1)).optional(),
    expectedArgs: z.record(z.unknown()).optional(),
    description: z.string().min(1)
  })
  .superRefine((value, context) => {
    if ((value.type === "tool_called" || value.type === "tool_not_called" || value.type === "tool_argument_match") && !value.toolName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.type} requires toolName.`
      });
    }

    if (value.type === "tool_call_order" && (!value.toolNames || value.toolNames.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tool_call_order requires toolNames."
      });
    }

    if (value.type === "tool_argument_match" && !value.expectedArgs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tool_argument_match requires expectedArgs."
      });
    }
  });

export const evalPromptSchema = z.object({
  prompt: z.string().min(1),
  assertions: z.array(z.string().min(1)).optional(),
  tools: z.array(mockToolDefinitionSchema).optional(),
  toolAssertions: z.array(toolAssertionSchema).optional()
});

export const evalPromptArraySchema = z.array(evalPromptSchema);

function formatToolCallCounts(toolCalls: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const toolCall of toolCalls) {
    counts.set(toolCall.name, (counts.get(toolCall.name) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
}

function formatExpectedOrder(toolNames: string[]): string {
  return `[${toolNames.join(", ")}]`;
}

function formatActualOrder(toolCalls: ToolCall[], toolNames: string[]): string {
  const relevantNames = new Set(toolNames);
  const actualOrder = toolCalls.filter((toolCall) => relevantNames.has(toolCall.name)).map((toolCall) => toolCall.name);
  return `[${actualOrder.join(", ")}]`;
}

export function evaluateToolAssertions(toolAssertions: ToolAssertion[], toolCalls: ToolCall[]): GradedAssertion[] {
  return toolAssertions.map((toolAssertion) => {
    if (toolAssertion.type === "tool_called") {
      const matchingCalls = toolCalls.filter((toolCall) => toolCall.name === toolAssertion.toolName);
      return {
        assertion: toolAssertion.description,
        passed: matchingCalls.length > 0,
        evidence:
          matchingCalls.length > 0
            ? `Tool '${toolAssertion.toolName}' was called ${matchingCalls.length} time${matchingCalls.length === 1 ? "" : "s"}.`
            : `Tool '${toolAssertion.toolName}' was not called.`,
        source: "tool"
      };
    }

    if (toolAssertion.type === "tool_not_called") {
      const matchingCalls = toolCalls.filter((toolCall) => toolCall.name === toolAssertion.toolName);
      return {
        assertion: toolAssertion.description,
        passed: matchingCalls.length === 0,
        evidence:
          matchingCalls.length === 0
            ? `Tool '${toolAssertion.toolName}' was not called.`
            : `Tool '${toolAssertion.toolName}' was called ${matchingCalls.length} time${matchingCalls.length === 1 ? "" : "s"}.`,
        source: "tool"
      };
    }

    if (toolAssertion.type === "tool_call_order") {
      const expectedOrder = toolAssertion.toolNames ?? [];
      let nextExpectedIndex = 0;
      for (const toolCall of toolCalls) {
        if (toolCall.name === expectedOrder[nextExpectedIndex]) {
          nextExpectedIndex += 1;
        }
      }

      return {
        assertion: toolAssertion.description,
        passed: nextExpectedIndex === expectedOrder.length,
        evidence:
          nextExpectedIndex === expectedOrder.length
            ? `Observed tool call order ${formatExpectedOrder(expectedOrder)}.`
            : `Expected call order ${formatExpectedOrder(expectedOrder)} but got ${formatActualOrder(toolCalls, expectedOrder)}.`,
        source: "tool"
      };
    }

    const matchingCall = toolCalls.find(
      (toolCall) =>
        toolCall.name === toolAssertion.toolName &&
        matchesArgumentSubset(toolCall.arguments, toolAssertion.expectedArgs ?? {})
    );

    return {
      assertion: toolAssertion.description,
      passed: Boolean(matchingCall),
      evidence: matchingCall
        ? `Tool '${toolAssertion.toolName}' was called with arguments matching ${JSON.stringify(toolAssertion.expectedArgs ?? {})}.`
        : `No '${toolAssertion.toolName}' call matched ${JSON.stringify(toolAssertion.expectedArgs ?? {})}.`,
      source: "tool"
    };
  });
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return JSON.parse(trimmed) as unknown[];
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown[];
  }

  throw new Error("Model did not return a JSON array.");
}

async function generatePrompts(
  skill: ParsedSkill,
  provider: LanguageModelProvider,
  model: string,
  count: number
): Promise<EvalPrompt[]> {
  const systemPrompt = [
    "You generate realistic evaluation prompts for an agent skill.",
    "Return JSON only.",
    "Format: [{\"prompt\":\"...\",\"assertions\":[\"...\", \"...\"]}]",
    "Assertions should be concrete and checkable."
  ].join(" ");

  const userPrompt = [
    `Skill name: ${skill.frontmatter.name}`,
    `Skill description: ${skill.frontmatter.description}`,
    "Skill instructions:",
    skill.content,
    "",
    `Generate ${count} prompts that stress the main capabilities and likely edge cases.`,
    // Tool-aware prompts require user-defined mock responses and are not auto-generated.
    "Each prompt should include 2-4 assertions."
  ].join("\n");

  const raw = await provider.sendMessage(systemPrompt, userPrompt, { model });
  const parsed = evalPromptArraySchema.safeParse(extractJsonArray(raw));
  if (!parsed.success) {
    throw new Error(`Failed to parse generated eval prompts: ${parsed.error.issues[0]?.message ?? "invalid prompt JSON"}`);
  }

  if (parsed.data.length !== count) {
    throw new Error(`Expected ${count} prompts, got ${parsed.data.length}.`);
  }

  return parsed.data;
}

export interface RunEvalOptions {
  provider: LanguageModelProvider;
  model: string;
  graderModel: string;
  numRuns: number;
  prompts?: EvalPrompt[];
  concurrency?: number;
  maxToolIterations?: number;
}

export async function runEval(skill: ParsedSkill, options: RunEvalOptions): Promise<EvalResult> {
  const prompts =
    options.prompts && options.prompts.length > 0
      ? evalPromptArraySchema.parse(options.prompts)
      : await generatePrompts(skill, options.provider, options.model, options.numRuns);

  const systemPrompt = [
    "You are an AI assistant with an activated skill.",
    "Follow this SKILL.md content exactly where applicable.",
    "",
    skill.raw
  ].join("\n");

  const results = await pMap(
    prompts,
    async (evalPrompt) => {
      let response: string;
      let toolCalls: ToolCall[] | undefined;
      let loopIterations: number | undefined;

      if (evalPrompt.tools && evalPrompt.tools.length > 0) {
        const toolRun = await runWithTools({
          provider: options.provider,
          model: options.model,
          systemPrompt,
          userMessage: evalPrompt.prompt,
          tools: evalPrompt.tools,
          maxIterations: options.maxToolIterations
        });

        response = toolRun.finalResponse;
        toolCalls = toolRun.toolCalls;
        loopIterations = toolRun.loopIterations;
      } else {
        response = await options.provider.sendMessage(systemPrompt, evalPrompt.prompt, { model: options.model });
      }

      const gradedAssertions = await gradeResponse({
        provider: options.provider,
        model: options.graderModel,
        skillName: skill.frontmatter.name,
        skillBody: skill.content,
        userPrompt: evalPrompt.prompt,
        modelResponse: response,
        assertions: evalPrompt.assertions
      });
      const structuralAssertions =
        evalPrompt.toolAssertions && evalPrompt.toolAssertions.length > 0
          ? evaluateToolAssertions(evalPrompt.toolAssertions, toolCalls ?? [])
          : [];
      const assertions = [...gradedAssertions, ...structuralAssertions];

      const passedAssertions = assertions.filter((assertion) => assertion.passed).length;
      return {
        prompt: evalPrompt.prompt,
        assertions,
        responseSummary: response.slice(0, 200),
        response,
        passedAssertions,
        totalAssertions: assertions.length,
        ...(toolCalls ? { toolCalls } : {}),
        ...(loopIterations !== undefined ? { loopIterations } : {})
      };
    },
    options.concurrency ?? 5
  );

  const totalAssertions = results.reduce((total, result) => total + result.totalAssertions, 0);
  const passedAssertions = results.reduce((total, result) => total + result.passedAssertions, 0);

  return {
    skillName: skill.frontmatter.name,
    model: options.model,
    graderModel: options.graderModel,
    provider: options.provider.name,
    prompts,
    results,
    summary: {
      totalPrompts: results.length,
      totalAssertions,
      passedAssertions
    }
  };
}
