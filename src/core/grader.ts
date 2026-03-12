import { z } from "zod";
import { LanguageModelProvider } from "../providers/types.js";

export interface GradedAssertion {
  assertion: string;
  passed: boolean;
  evidence: string;
  source?: "grader" | "tool";
}

const gradedAssertionSchema = z.object({
  assertion: z.string(),
  passed: z.boolean(),
  evidence: z.string()
});

const graderOutputSchema = z.object({
  assertions: z.array(gradedAssertionSchema)
});

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }

  throw new Error("Grader did not return a JSON object.");
}

export interface GradeResponseOptions {
  provider: LanguageModelProvider;
  model: string;
  skillName: string;
  skillBody: string;
  userPrompt: string;
  modelResponse: string;
  assertions?: string[];
}

const DEFAULT_ASSERTIONS = [
  "The response follows the skill instructions faithfully.",
  "The response is well-structured and actionable.",
  "The response addresses the user prompt directly."
];

export interface GraderPrompts {
  assertions: string[];
  systemPrompt: string;
  userPrompt: string;
}

export function buildGraderPrompts(
  options: Omit<GradeResponseOptions, "provider" | "model">
): GraderPrompts {
  const assertions =
    options.assertions && options.assertions.length > 0 ? options.assertions : DEFAULT_ASSERTIONS;

  const systemPrompt = [
    "You are a strict evaluator for agent skill outputs.",
    "Assess each assertion and return JSON only.",
    "Required output format: {\"assertions\":[{\"assertion\":\"...\",\"passed\":true|false,\"evidence\":\"...\"}]}"
  ].join(" ");

  const userPrompt = [
    `Skill: ${options.skillName}`,
    "Skill instructions:",
    options.skillBody,
    "",
    `User prompt: ${options.userPrompt}`,
    "",
    "Model response:",
    options.modelResponse,
    "",
    "Assertions to evaluate:",
    assertions.map((assertion, index) => `${index + 1}. ${assertion}`).join("\n")
  ].join("\n");

  return {
    assertions,
    systemPrompt,
    userPrompt
  };
}

export function parseGraderOutput(raw: string): GradedAssertion[] {
  const parsed = graderOutputSchema.safeParse(extractJsonObject(raw));

  if (!parsed.success) {
    throw new Error(`Failed to parse grader output: ${parsed.error.issues[0]?.message ?? "invalid grader JSON"}`);
  }

  return parsed.data.assertions;
}

export async function gradeResponse(options: GradeResponseOptions): Promise<GradedAssertion[]> {
  const prompts = buildGraderPrompts(options);
  const raw = await options.provider.sendMessage(prompts.systemPrompt, prompts.userPrompt, { model: options.model });
  return parseGraderOutput(raw).map((assertion) => ({
    ...assertion,
    source: "grader"
  }));
}
