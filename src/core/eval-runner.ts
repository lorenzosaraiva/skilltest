import { z } from "zod";
import { gradeResponse, GradedAssertion } from "./grader.js";
import { ParsedSkill } from "./skill-parser.js";
import { LanguageModelProvider } from "../providers/types.js";

export interface EvalPrompt {
  prompt: string;
  assertions?: string[];
}

export interface EvalPromptResult {
  prompt: string;
  assertions: GradedAssertion[];
  responseSummary: string;
  response: string;
  passedAssertions: number;
  totalAssertions: number;
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

const evalPromptSchema = z.object({
  prompt: z.string().min(1),
  assertions: z.array(z.string().min(1)).optional()
});

export const evalPromptArraySchema = z.array(evalPromptSchema);

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
}

export async function runEval(skill: ParsedSkill, options: RunEvalOptions): Promise<EvalResult> {
  const prompts =
    options.prompts && options.prompts.length > 0
      ? evalPromptArraySchema.parse(options.prompts)
      : await generatePrompts(skill, options.provider, options.model, options.numRuns);

  const results: EvalPromptResult[] = [];

  for (const evalPrompt of prompts) {
    const systemPrompt = [
      "You are an AI assistant with an activated skill.",
      "Follow this SKILL.md content exactly where applicable.",
      "",
      skill.raw
    ].join("\n");

    const response = await options.provider.sendMessage(systemPrompt, evalPrompt.prompt, { model: options.model });

    const gradedAssertions = await gradeResponse({
      provider: options.provider,
      model: options.graderModel,
      skillName: skill.frontmatter.name,
      skillBody: skill.content,
      userPrompt: evalPrompt.prompt,
      modelResponse: response,
      assertions: evalPrompt.assertions
    });

    const passedAssertions = gradedAssertions.filter((assertion) => assertion.passed).length;
    results.push({
      prompt: evalPrompt.prompt,
      assertions: gradedAssertions,
      responseSummary: response.slice(0, 200),
      response,
      passedAssertions,
      totalAssertions: gradedAssertions.length
    });
  }

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
