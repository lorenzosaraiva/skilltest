import path from "node:path";
import { z } from "zod";
import { ParsedSkill, parseSkillStrict } from "./skill-parser.js";
import { LanguageModelProvider } from "../providers/types.js";
import { pMap } from "../utils/concurrency.js";
import { listFilesRecursive } from "../utils/fs.js";

export interface RouteTestCase {
  query: string;
  targetSkill: string;
  actualSkill: string;
  correct: boolean;
  rawModelResponse?: string;
}

export interface SkillRouteMetrics {
  skill: string;
  queriesTotal: number;
  correct: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface RoutingConflict {
  skillA: string;
  skillB: string;
  bleedAtoB: number;
  bleedBtoA: number;
}

export interface RouteTestResult {
  skillDir: string;
  skills: string[];
  model: string;
  provider: string;
  seed?: number;
  numQueriesPerSkill: number;
  cases: RouteTestCase[];
  matrix: Record<string, Record<string, number>>;
  matrixPct: Record<string, Record<string, number>>;
  perSkillMetrics: SkillRouteMetrics[];
  conflicts: RoutingConflict[];
  suggestions: string[];
  overallAccuracy: number;
}

export interface RunRouteTestOptions {
  model: string;
  provider: LanguageModelProvider;
  numQueriesPerSkill?: number;
  conflictThreshold?: number;
  seed?: number;
  concurrency?: number;
  verbose?: boolean;
}

const stringArraySchema = z.array(z.string().min(1));

function parseJsonArrayFromModelOutput(raw: string): unknown[] {
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

function parseRouteDecision(rawResponse: string, skillNames: string[]): string {
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

async function discoverSkillPaths(skillDir: string): Promise<string[]> {
  const allFiles = await listFilesRecursive(skillDir);
  return allFiles.filter((f) => path.basename(f) === "SKILL.md");
}

async function generatePositiveQueriesForSkill(
  skill: ParsedSkill,
  provider: LanguageModelProvider,
  model: string,
  count: number
): Promise<string[]> {
  const systemPrompt = [
    "You generate realistic user queries that should trigger a specific agent skill.",
    "Return a JSON array of strings only. No markdown, no comments.",
    "Each string is one realistic user query that clearly belongs to this skill.",
    "Queries should look like real user requests with enough context to drive a routing decision."
  ].join(" ");

  const userPrompt = [
    `Skill name: ${skill.frontmatter.name}`,
    `Skill description: ${skill.frontmatter.description}`,
    `Generate exactly ${count} distinct queries that should trigger this skill.`
  ].join("\n");

  const raw = await provider.sendMessage(systemPrompt, userPrompt, { model });
  const parsed = stringArraySchema.safeParse(parseJsonArrayFromModelOutput(raw));
  if (!parsed.success) {
    throw new Error(
      `Failed to parse generated queries for skill '${skill.frontmatter.name}': ${parsed.error.issues[0]?.message ?? "invalid format"}`
    );
  }
  if (parsed.data.length < count) {
    throw new Error(
      `Expected ${count} queries for skill '${skill.frontmatter.name}', got ${parsed.data.length}.`
    );
  }
  return parsed.data.slice(0, count);
}

function buildSkillListText(skills: ParsedSkill[]): string {
  return skills.map((s) => `- ${s.frontmatter.name}: ${s.frontmatter.description}`).join("\n");
}

export function buildConfusionMatrix(
  cases: RouteTestCase[],
  skillNames: string[],
  numQueriesPerSkill: number
): { matrix: Record<string, Record<string, number>>; matrixPct: Record<string, Record<string, number>> } {
  const allActualValues = [...skillNames, "none", "unrecognized"];
  const matrix: Record<string, Record<string, number>> = {};
  for (const target of skillNames) {
    matrix[target] = {};
    for (const actual of allActualValues) {
      matrix[target]![actual] = 0;
    }
  }
  for (const c of cases) {
    const row = matrix[c.targetSkill];
    if (row) {
      row[c.actualSkill] = (row[c.actualSkill] ?? 0) + 1;
    }
  }
  const matrixPct: Record<string, Record<string, number>> = {};
  const divisor = numQueriesPerSkill > 0 ? numQueriesPerSkill : 1;
  for (const target of skillNames) {
    matrixPct[target] = {};
    for (const actual of allActualValues) {
      matrixPct[target]![actual] = (matrix[target]![actual] ?? 0) / divisor;
    }
  }
  return { matrix, matrixPct };
}

export function computePerSkillMetrics(
  skillNames: string[],
  matrix: Record<string, Record<string, number>>,
  numQueriesPerSkill: number
): SkillRouteMetrics[] {
  return skillNames.map((skill) => {
    const tp = matrix[skill]?.[skill] ?? 0;
    const fp = skillNames
      .filter((s) => s !== skill)
      .reduce((sum, other) => sum + (matrix[other]?.[skill] ?? 0), 0);
    const recall = numQueriesPerSkill === 0 ? 0 : tp / numQueriesPerSkill;
    const precDenom = tp + fp;
    const precision = precDenom === 0 ? 0 : tp / precDenom;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { skill, queriesTotal: numQueriesPerSkill, correct: tp, precision, recall, f1 };
  });
}

export function detectConflicts(
  skillNames: string[],
  matrixPct: Record<string, Record<string, number>>,
  conflictThreshold: number
): RoutingConflict[] {
  const conflicts: RoutingConflict[] = [];
  for (let i = 0; i < skillNames.length; i++) {
    for (let j = i + 1; j < skillNames.length; j++) {
      const skillA = skillNames[i]!;
      const skillB = skillNames[j]!;
      const bleedAtoB = matrixPct[skillA]?.[skillB] ?? 0;
      const bleedBtoA = matrixPct[skillB]?.[skillA] ?? 0;
      if (Math.max(bleedAtoB, bleedBtoA) > conflictThreshold) {
        conflicts.push({ skillA, skillB, bleedAtoB, bleedBtoA });
      }
    }
  }
  return conflicts;
}

function buildRouteSuggestions(perSkillMetrics: SkillRouteMetrics[], conflicts: RoutingConflict[]): string[] {
  const suggestions: string[] = [];
  for (const metrics of perSkillMetrics) {
    if (metrics.f1 < 0.7) {
      suggestions.push(
        `'${metrics.skill}' has low F1 (${(metrics.f1 * 100).toFixed(1)}%) — consider clarifying its description and scope boundaries.`
      );
    }
  }
  for (const conflict of conflicts) {
    suggestions.push(
      `'${conflict.skillA}' and '${conflict.skillB}' overlap: ${(conflict.bleedAtoB * 100).toFixed(1)}% of ${conflict.skillA} queries routed to ${conflict.skillB}, ${(conflict.bleedBtoA * 100).toFixed(1)}% the other way — consider narrowing scope boundaries.`
    );
  }
  if (suggestions.length === 0) {
    suggestions.push("Routing looks clean. All skills are well-differentiated on this sample.");
  }
  return suggestions;
}

export async function runRouteTest(skillDir: string, options: RunRouteTestOptions): Promise<RouteTestResult> {
  const numQueriesPerSkill = options.numQueriesPerSkill ?? 10;
  const conflictThreshold = options.conflictThreshold ?? 0.1;
  const concurrency = options.concurrency ?? 5;
  const absoluteSkillDir = path.resolve(skillDir);

  const skillPaths = await discoverSkillPaths(absoluteSkillDir);
  if (skillPaths.length < 2) {
    throw new Error(
      `Route test requires at least 2 skills. Found ${skillPaths.length} in: ${skillDir}`
    );
  }
  if (skillPaths.length > 20) {
    process.stderr.write(
      `Warning: ${skillPaths.length} skills found. This will make ${skillPaths.length * numQueriesPerSkill} routing model calls.\n`
    );
  }

  const skills = await Promise.all(skillPaths.map((p) => parseSkillStrict(p)));
  const skillNames = skills.map((s) => s.frontmatter.name);

  const queriesPerSkill = await pMap(
    skills,
    (skill) => generatePositiveQueriesForSkill(skill, options.provider, options.model, numQueriesPerSkill),
    concurrency
  );

  interface WorkItem { query: string; targetSkill: string }
  const workItems: WorkItem[] = [];
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    const queries = queriesPerSkill[i]!;
    for (const query of queries) {
      workItems.push({ query, targetSkill: skill.frontmatter.name });
    }
  }

  const skillListText = buildSkillListText(skills);
  const systemPrompt =
    "Select the single best skill for the user's request from the provided list. Respond with only the skill name, or 'none' if nothing fits.";

  const cases = await pMap(
    workItems,
    async ({ query, targetSkill }) => {
      const userPrompt = `Available skills:\n${skillListText}\n\nUser query: ${query}`;
      const rawResponse = await options.provider.sendMessage(systemPrompt, userPrompt, { model: options.model });
      const actualSkill = parseRouteDecision(rawResponse, skillNames);
      return {
        query,
        targetSkill,
        actualSkill,
        correct: actualSkill === targetSkill,
        rawModelResponse: options.verbose ? rawResponse : undefined
      } satisfies RouteTestCase;
    },
    concurrency
  );

  const { matrix, matrixPct } = buildConfusionMatrix(cases, skillNames, numQueriesPerSkill);
  const perSkillMetrics = computePerSkillMetrics(skillNames, matrix, numQueriesPerSkill);
  const conflicts = detectConflicts(skillNames, matrixPct, conflictThreshold);
  const correctCount = cases.filter((c) => c.correct).length;
  const overallAccuracy = cases.length === 0 ? 0 : correctCount / cases.length;
  const suggestions = buildRouteSuggestions(perSkillMetrics, conflicts);

  return {
    skillDir: absoluteSkillDir,
    skills: skillNames,
    model: options.model,
    provider: options.provider.name,
    seed: options.seed,
    numQueriesPerSkill,
    cases,
    matrix,
    matrixPct,
    perSkillMetrics,
    conflicts,
    suggestions,
    overallAccuracy
  };
}
