import { z } from "zod";
import { LanguageModelProvider } from "../providers/types.js";

export interface GradedAssertion {
  assertion: string;
  passed: boolean;
  evidence: string;
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

export async function gradeResponse(options: GradeResponseOptions): Promise<GradedAssertion[]> {
  const assertionList =
    options.assertions && options.assertions.length > 0
      ? options.assertions
      : [
          "The response follows the skill instructions faithfully.",
          "The response is well-structured and actionable.",
          "The response addresses the user prompt directly."
        ];

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
    assertionList.map((assertion, index) => `${index + 1}. ${assertion}`).join("\n")
  ].join("\n");

  const raw = await options.provider.sendMessage(systemPrompt, userPrompt, { model: options.model });
  const parsed = graderOutputSchema.safeParse(extractJsonObject(raw));

  if (!parsed.success) {
    throw new Error(`Failed to parse grader output: ${parsed.error.issues[0]?.message ?? "invalid grader JSON"}`);
  }

  return parsed.data.assertions;
}
