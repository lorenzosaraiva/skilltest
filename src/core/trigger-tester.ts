import { z } from "zod";
import { ParsedSkill, parseSkillStrict } from "./skill-parser.js";
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
  selectedCompetitor?: string;
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
  competitors?: CompetitorSkill[];
  queries: TriggerQuery[];
  cases: TriggerTestCaseResult[];
  metrics: TriggerMetrics;
  suggestions: string[];
}

export interface CompetitorSkill {
  name: string;
  description: string;
  sourcePath: string;
}

const triggerQuerySchema = z.object({
  query: z.string().min(1),
  should_trigger: z.boolean()
});

export const triggerQueryArraySchema = z.array(triggerQuerySchema);
export const triggerNumQueriesSchema = z
  .number()
  .int()
  .min(2)
  .refine((value) => value % 2 === 0, "numQueries must be an even number.");

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

export interface PreparedTriggerQuery {
  testQuery: TriggerQuery;
  fakeSkills: Array<{ name: string; description: string }>;
  allSkills: Array<{ name: string; description: string }>;
  skillListText: string;
}

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

export function validateNumQueries(numQueries: number): number {
  return triggerNumQueriesSchema.parse(numQueries);
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
  numQueries: number,
  competitors?: CompetitorSkill[]
): Promise<TriggerQuery[]> {
  validateNumQueries(numQueries);
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
    ...(competitors && competitors.length > 0
      ? [
          "",
          "Competitor skills in the same domain:",
          ...competitors.map((competitor) => `- ${competitor.name}: ${competitor.description}`),
          "",
          "Generate queries that test whether the target skill triggers correctly even when these similar skills exist.",
          "Positive queries should clearly belong to the target skill, not the competitors.",
          "Negative queries should belong to a competitor or to no skill at all."
        ]
      : []),
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

export function prepareTriggerQueries(
  skill: Pick<ParsedSkill, "frontmatter">,
  queries: TriggerQuery[],
  seed?: number,
  competitors?: CompetitorSkill[]
): PreparedTriggerQuery[] {
  const rng = createRng(seed);
  const competitorCandidates = (competitors ?? []).map((competitor) => ({
    name: competitor.name,
    description: competitor.description
  }));

  return queries.map((testQuery) => {
    const usingCompetitors = competitorCandidates.length > 0;
    const fakeCount = usingCompetitors
      ? testQuery.should_trigger
        ? 2 + Math.floor(rng() * 3)
        : 3 + Math.floor(rng() * 3)
      : 5 + Math.floor(rng() * 5);
    const fakeSkills = sample(FAKE_SKILLS, fakeCount, rng);
    const allSkills = usingCompetitors
      ? shuffle(
          [
            ...competitorCandidates,
            ...fakeSkills,
            ...(testQuery.should_trigger
              ? [
                  {
                    name: skill.frontmatter.name,
                    description: skill.frontmatter.description
                  }
                ]
              : [])
          ],
          rng
        )
      : shuffle(
          [
            ...fakeSkills,
            {
              name: skill.frontmatter.name,
              description: skill.frontmatter.description
            }
          ],
          rng
        );

    return {
      testQuery,
      fakeSkills,
      allSkills,
      skillListText: allSkills.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n")
    };
  });
}

export function calculateMetrics(skillName: string, cases: TriggerTestCaseResult[]): TriggerMetrics {
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

export function assertCompetitorNamesDistinct(skillName: string, competitors: CompetitorSkill[]): void {
  for (const competitor of competitors) {
    if (competitor.name === skillName) {
      throw new Error(`Competitor skill '${competitor.name}' has the same name as the skill under test.`);
    }
  }
}

export function buildTriggerCaseResult(options: {
  testQuery: TriggerQuery;
  skillName: string;
  decision: string;
  competitorNames?: string[];
  rawModelResponse?: string;
}): TriggerTestCaseResult {
  const expected = options.testQuery.should_trigger ? options.skillName : "none";
  const matched = options.testQuery.should_trigger ? options.decision === options.skillName : options.decision !== options.skillName;
  const selectedCompetitor = options.competitorNames?.includes(options.decision) ? options.decision : undefined;

  return {
    query: options.testQuery.query,
    shouldTrigger: options.testQuery.should_trigger,
    expected,
    actual: options.decision,
    matched,
    selectedCompetitor,
    rawModelResponse: options.rawModelResponse
  };
}

function buildSuggestions(
  skillName: string,
  metrics: TriggerMetrics,
  cases: TriggerTestCaseResult[],
  competitors?: CompetitorSkill[]
): string[] {
  const suggestions: string[] = [];
  if (metrics.falseNegatives > 0) {
    suggestions.push(
      "False negatives found: clarify capability keywords and add explicit 'use when ...' phrasing in description."
    );
    if (competitors && competitors.length > 0) {
      const competitorCounts = new Map<string, number>();
      for (const testCase of cases) {
        if (!testCase.shouldTrigger || testCase.actual === skillName || !testCase.selectedCompetitor) {
          continue;
        }
        competitorCounts.set(testCase.selectedCompetitor, (competitorCounts.get(testCase.selectedCompetitor) ?? 0) + 1);
      }

      for (const [competitorName, count] of competitorCounts.entries()) {
        suggestions.push(
          `Skill '${competitorName}' was selected instead of '${skillName}' for ${count} quer${count === 1 ? "y" : "ies"}. Differentiate your description from '${competitorName}'.`
        );
      }
    }
  }
  if (metrics.falsePositives > 0) {
    suggestions.push("False positives found: narrow scope boundaries and add explicit non-goals in description.");
    if (competitors && competitors.length > 0) {
      suggestions.push(
        `With competitor skills present, ${metrics.falsePositives} negative quer${metrics.falsePositives === 1 ? "y still" : "ies still"} triggered '${skillName}'. Narrow your description's scope boundaries.`
      );
    }
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
  compare?: string[];
  seed?: number;
  concurrency?: number;
  verbose?: boolean;
}

async function loadCompetitorSkills(comparePaths: string[]): Promise<CompetitorSkill[]> {
  const competitors: CompetitorSkill[] = [];

  for (const comparePath of comparePaths) {
    const parsed = await parseSkillStrict(comparePath);
    competitors.push({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      sourcePath: comparePath
    });
  }

  return competitors;
}

export async function runTriggerTest(skill: ParsedSkill, options: RunTriggerTestOptions): Promise<TriggerTestResult> {
  const competitors =
    options.compare && options.compare.length > 0 ? await loadCompetitorSkills(options.compare) : undefined;
  if (competitors && competitors.length > 0) {
    assertCompetitorNamesDistinct(skill.frontmatter.name, competitors);
  }

  const queries =
    options.queries && options.queries.length > 0
      ? triggerQueryArraySchema.parse(options.queries)
      : await generateQueriesWithModel(skill, options.provider, options.model, options.numQueries, competitors);

  const skillName = skill.frontmatter.name;
  const preparedQueries = prepareTriggerQueries(skill, queries, options.seed, competitors);
  const competitorNames = competitors?.map((competitor) => competitor.name) ?? [];

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
        Array.from(new Set([skillName, ...allSkills.map((entry) => entry.name)]))
      );

      return buildTriggerCaseResult({
        testQuery,
        skillName,
        decision,
        competitorNames,
        rawModelResponse: options.verbose ? rawResponse : undefined
      });
    },
    options.concurrency ?? 5
  );

  const metrics = calculateMetrics(skillName, results);

  return {
    skillName,
    model: options.model,
    provider: options.provider.name,
    seed: options.seed,
    competitors,
    queries,
    cases: results,
    metrics,
    suggestions: buildSuggestions(skillName, metrics, results, competitors)
  };
}
