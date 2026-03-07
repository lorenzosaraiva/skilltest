import { z } from "zod";
import { ParsedSkill } from "./skill-parser.js";
import { LanguageModelProvider } from "../providers/types.js";
import { pMap } from "../utils/concurrency.js";

export interface TriggerQuery {
  query: string;
  should_trigger: boolean;
}

export interface TriggerTestCaseResult {
  query: string;
  shouldTrigger: boolean;
  expected: string;
  actual: string;
  matched: boolean;
  rawModelResponse?: string;
}

export interface TriggerMetrics {
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface TriggerTestResult {
  skillName: string;
  model: string;
  provider: string;
  seed?: number;
  queries: TriggerQuery[];
  cases: TriggerTestCaseResult[];
  metrics: TriggerMetrics;
  suggestions: string[];
}

const triggerQuerySchema = z.object({
  query: z.string().min(1),
  should_trigger: z.boolean()
});

export const triggerQueryArraySchema = z.array(triggerQuerySchema);

const FAKE_SKILLS: Array<{ name: string; description: string }> = [
  { name: "code-review", description: "Reviews code changes for bugs, regressions, and maintainability issues." },
  { name: "api-tester", description: "Designs and runs REST API tests, validating status codes and response shapes." },
  { name: "db-migrator", description: "Plans and generates safe database migration scripts with rollback guidance." },
  { name: "bug-repro", description: "Reproduces reported bugs by building deterministic minimal test cases." },
  { name: "release-notes", description: "Drafts release notes from commits and PR metadata for stakeholders." },
  { name: "log-analyzer", description: "Analyzes service logs to identify error clusters and likely root causes." },
  { name: "performance-audit", description: "Finds hotspots in runtime and suggests profiling-driven optimizations." },
  { name: "security-audit", description: "Checks code and config for common security vulnerabilities and risky defaults." },
  { name: "refactor-planner", description: "Breaks large refactors into safe incremental steps with validation plans." },
  { name: "schema-designer", description: "Designs JSON schemas and validates data contracts for integrations." },
  { name: "docs-writer", description: "Writes developer documentation, tutorials, and API usage examples." },
  { name: "cli-scaffolder", description: "Creates CLI project skeletons with argument parsing and help text." },
  { name: "incident-triage", description: "Triage production incidents with severity tagging and next-action checklists." },
  { name: "test-generator", description: "Generates unit and integration test cases from feature requirements." },
  { name: "prompt-tuner", description: "Improves prompts for reliability, formatting, and failure handling." }
];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed?: number): () => number {
  return seed !== undefined ? mulberry32(seed) : Math.random;
}

function shuffle<T>(values: T[], rng: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function sample<T>(values: T[], count: number, rng: () => number): T[] {
  return shuffle(values, rng).slice(0, Math.max(0, Math.min(count, values.length)));
}

function parseJsonArrayFromModelOutput(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return JSON.parse(trimmed) as unknown[];
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const possibleJson = trimmed.slice(start, end + 1);
    return JSON.parse(possibleJson) as unknown[];
  }

  throw new Error("Model did not return a JSON array.");
}

async function generateQueriesWithModel(
  skill: ParsedSkill,
  provider: LanguageModelProvider,
  model: string,
  numQueries: number
): Promise<TriggerQuery[]> {
  const shouldTriggerCount = Math.floor(numQueries / 2);
  const shouldNotTriggerCount = numQueries - shouldTriggerCount;

  const systemPrompt = [
    "You generate realistic user prompts to test whether a specific agent skill triggers.",
    "Return JSON only. No markdown, no comments.",
    "Each entry must be an object: {\"query\": string, \"should_trigger\": boolean}.",
    "Create substantive prompts, not toy one-liners."
  ].join(" ");

  const userPrompt = [
    `Skill name: ${skill.frontmatter.name}`,
    `Skill description: ${skill.frontmatter.description}`,
    `Generate ${numQueries} prompts total.`,
    `Exactly ${shouldTriggerCount} should have should_trigger=true.`,
    `Exactly ${shouldNotTriggerCount} should have should_trigger=false.`,
    "Prompts should look like real user requests with enough context to drive a trigger decision."
  ].join("\n");

  const raw = await provider.sendMessage(systemPrompt, userPrompt, { model });
  const parsed = triggerQueryArraySchema.safeParse(parseJsonArrayFromModelOutput(raw));
  if (!parsed.success) {
    throw new Error(`Failed to parse generated queries: ${parsed.error.issues[0]?.message ?? "invalid format"}`);
  }

  const trueCount = parsed.data.filter((item) => item.should_trigger).length;
  const falseCount = parsed.data.length - trueCount;
  if (parsed.data.length !== numQueries || trueCount !== shouldTriggerCount || falseCount !== shouldNotTriggerCount) {
    throw new Error(
      `Generated query split mismatch. Expected ${numQueries} (${shouldTriggerCount}/${shouldNotTriggerCount}), got ${parsed.data.length} (${trueCount}/${falseCount}).`
    );
  }

  return parsed.data;
}

function parseDecision(rawResponse: string, skillNames: string[]): string {
  const normalized = rawResponse.trim().toLowerCase();
  if (normalized === "none" || normalized.startsWith("none")) {
    return "none";
  }

  for (const skillName of skillNames) {
    const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(rawResponse)) {
      return skillName;
    }
  }

  return "unrecognized";
}

function calculateMetrics(skillName: string, cases: TriggerTestCaseResult[]): TriggerMetrics {
  let truePositives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const testCase of cases) {
    const choseTargetSkill = testCase.actual === skillName;
    if (testCase.shouldTrigger && choseTargetSkill) {
      truePositives += 1;
      continue;
    }
    if (testCase.shouldTrigger && !choseTargetSkill) {
      falseNegatives += 1;
      continue;
    }
    if (!testCase.shouldTrigger && choseTargetSkill) {
      falsePositives += 1;
      continue;
    }
    trueNegatives += 1;
  }

  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  const precision = precisionDenominator === 0 ? 0 : truePositives / precisionDenominator;
  const recall = recallDenominator === 0 ? 0 : truePositives / recallDenominator;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    trueNegatives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1
  };
}

function buildSuggestions(metrics: TriggerMetrics): string[] {
  const suggestions: string[] = [];
  if (metrics.falseNegatives > 0) {
    suggestions.push(
      "False negatives found: clarify capability keywords and add explicit 'use when ...' phrasing in description."
    );
  }
  if (metrics.falsePositives > 0) {
    suggestions.push("False positives found: narrow scope boundaries and add explicit non-goals in description.");
  }
  if (suggestions.length === 0) {
    suggestions.push("Trigger behavior looks clean on this sample. Keep monitoring with domain-specific custom queries.");
  }
  return suggestions;
}

export interface RunTriggerTestOptions {
  model: string;
  provider: LanguageModelProvider;
  queries?: TriggerQuery[];
  numQueries: number;
  seed?: number;
  concurrency?: number;
  verbose?: boolean;
}

export async function runTriggerTest(skill: ParsedSkill, options: RunTriggerTestOptions): Promise<TriggerTestResult> {
  const rng = createRng(options.seed);
  const queries =
    options.queries && options.queries.length > 0
      ? triggerQueryArraySchema.parse(options.queries)
      : await generateQueriesWithModel(skill, options.provider, options.model, options.numQueries);

  const skillName = skill.frontmatter.name;
  const preparedQueries = queries.map((testQuery) => {
    const fakeCount = 5 + Math.floor(rng() * 5);
    const fakeSkills = sample(FAKE_SKILLS, fakeCount, rng);
    const allSkills = shuffle([
      ...fakeSkills,
      {
        name: skill.frontmatter.name,
        description: skill.frontmatter.description
      }
    ], rng);

    const skillListText = allSkills.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n");
    return {
      testQuery,
      fakeCount,
      fakeSkills,
      allSkills,
      skillListText
    };
  });

  const systemPrompt = [
    "You are selecting one skill to activate for a user query.",
    "Choose the single best matching skill name from the provided list, or 'none' if no skill is a good fit.",
    "Respond with only the skill name or 'none'."
  ].join(" ");

  const results = await pMap(
    preparedQueries,
    async ({ testQuery, allSkills, skillListText }) => {
      const userPrompt = [`Available skills:`, skillListText, "", `User query: ${testQuery.query}`].join("\n");
      const rawResponse = await options.provider.sendMessage(systemPrompt, userPrompt, { model: options.model });
      const decision = parseDecision(
        rawResponse,
        allSkills.map((entry) => entry.name)
      );

      const expected = testQuery.should_trigger ? skillName : "none";
      const matched = testQuery.should_trigger ? decision === skillName : decision !== skillName;

      return {
        query: testQuery.query,
        shouldTrigger: testQuery.should_trigger,
        expected,
        actual: decision,
        matched,
        rawModelResponse: options.verbose ? rawResponse : undefined
      };
    },
    options.concurrency ?? 5
  );

  const metrics = calculateMetrics(skillName, results);

  return {
    skillName,
    model: options.model,
    provider: options.provider.name,
    seed: options.seed,
    queries,
    cases: results,
    metrics,
    suggestions: buildSuggestions(metrics)
  };
}
