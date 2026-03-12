import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { EvalPrompt } from "./eval-runner.js";
import { CheckRunResult, runCheck } from "./check-runner.js";
import {
  extractRelativeFileReferences,
  ParsedSkill,
  parseSkillDocumentStrict,
  parseSkillStrict
} from "./skill-parser.js";
import { TriggerQuery } from "./trigger-tester.js";
import { pathExists } from "../utils/fs.js";
import { LintFailOn } from "../utils/config.js";
import { LanguageModelProvider } from "../providers/types.js";

const improveRewriteSchema = z.object({
  frontmatter: z.record(z.unknown()),
  content: z.string().min(1),
  changeSummary: z.array(z.string().min(1)).min(1),
  targetedProblems: z.array(z.string().min(1)).min(1)
});

export interface ImprovementBrief {
  lintIssues: Array<{
    checkId: string;
    title: string;
    status: "warn" | "fail";
    message: string;
    suggestion?: string;
    startLine?: number;
    endLine?: number;
  }>;
  triggerFailures: Array<{
    query: string;
    expected: string;
    actual: string;
    selectedCompetitor?: string;
    rawModelResponse?: string;
  }>;
  evalFailures: Array<{
    prompt: string;
    assertion: string;
    evidence: string;
    source: "grader" | "tool" | "unknown";
  }>;
  triggerSuggestions: string[];
}

export interface ImproveCandidate {
  frontmatter: Record<string, unknown>;
  content: string;
  raw: string;
  changeSummary: string[];
  targetedProblems: string[];
}

export interface ImproveMetricDelta {
  before: number;
  after: number;
  delta: number;
}

export interface ImproveBooleanDelta {
  before: boolean;
  after: boolean;
}

export interface ImproveDelta {
  lintFailures: ImproveMetricDelta;
  lintWarnings: ImproveMetricDelta;
  triggerF1: ImproveMetricDelta;
  evalAssertPassRate: ImproveMetricDelta;
  overallPassed: ImproveBooleanDelta;
  improved: boolean;
  hasRegression: boolean;
}

export interface ImproveRunResult {
  target: string;
  provider: string;
  model: string;
  originalRaw: string;
  thresholds: {
    minF1: number;
    minAssertPassRate: number;
  };
  baseline: CheckRunResult;
  candidate: ImproveCandidate | null;
  verification: CheckRunResult | null;
  delta: ImproveDelta | null;
  applied: boolean;
  outputPath?: string;
  blockedReason?: string;
}

export interface RunImproveOptions {
  provider: LanguageModelProvider;
  model: string;
  lintFailOn: LintFailOn;
  lintSuppress: string[];
  lintPlugins: string[];
  compare?: string[];
  numQueries: number;
  triggerSeed?: number;
  queries?: TriggerQuery[];
  prompts?: EvalPrompt[];
  evalNumRuns: number;
  evalMaxToolIterations: number;
  minF1: number;
  minAssertPassRate: number;
  concurrency?: number;
  verbose?: boolean;
  apply?: boolean;
  outputPath?: string;
  onStage?: (stage: "baseline" | "generate" | "validate" | "verify" | "write") => void;
}

function calculateEvalAssertPassRate(result: CheckRunResult["eval"]): number {
  if (!result || result.summary.totalAssertions === 0) {
    return 0;
  }

  return result.summary.passedAssertions / result.summary.totalAssertions;
}

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

  throw new Error("Improver did not return a JSON object.");
}

function orderFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of ["name", "description", "license"]) {
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      ordered[key] = frontmatter[key];
    }
  }

  for (const [key, value] of Object.entries(frontmatter)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = value;
    }
  }

  return ordered;
}

function detectLineEnding(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function buildSkillMarkdown(frontmatter: Record<string, unknown>, content: string, lineEnding: string): string {
  const normalizedBody = content.trim();
  if (normalizedBody.length === 0) {
    throw new Error("Candidate rewrite produced an empty SKILL.md body.");
  }

  const frontmatterBlock = yaml
    .dump(orderFrontmatter(frontmatter), {
    lineWidth: 0,
    noRefs: true,
    sortKeys: false
    })
    .replace(/\n/g, lineEnding);

  return `---${lineEnding}${frontmatterBlock}---${lineEnding}${lineEnding}${normalizedBody.replace(/\n/g, lineEnding)}${lineEnding}`;
}

async function validateRelativeReferences(raw: string, skillRoot: string): Promise<void> {
  for (const reference of extractRelativeFileReferences(raw)) {
    const resolved = path.resolve(skillRoot, reference);
    const relativeToRoot = path.relative(skillRoot, resolved);
    const escapesRoot =
      relativeToRoot === "" ? false : relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot);

    if (escapesRoot) {
      throw new Error(`Candidate rewrite introduced an out-of-root reference: ${reference}`);
    }

    if (!(await pathExists(resolved))) {
      throw new Error(`Candidate rewrite introduced a broken relative reference: ${reference}`);
    }
  }
}

async function buildCandidate(skill: ParsedSkill, rewrite: z.infer<typeof improveRewriteSchema>): Promise<ImproveCandidate> {
  if (typeof rewrite.frontmatter.name === "string" && rewrite.frontmatter.name !== skill.frontmatter.name) {
    throw new Error(`Candidate rewrite attempted to rename skill '${skill.frontmatter.name}' to '${rewrite.frontmatter.name}'.`);
  }

  if (
    skill.frontmatter.license &&
    typeof rewrite.frontmatter.license === "string" &&
    rewrite.frontmatter.license !== skill.frontmatter.license
  ) {
    throw new Error(
      `Candidate rewrite attempted to change license '${skill.frontmatter.license}' to '${rewrite.frontmatter.license}'.`
    );
  }

  const mergedFrontmatter = {
    ...skill.frontmatter,
    ...rewrite.frontmatter,
    name: skill.frontmatter.name,
    ...(skill.frontmatter.license ? { license: skill.frontmatter.license } : {})
  };

  const raw = buildSkillMarkdown(mergedFrontmatter, rewrite.content, detectLineEnding(skill.raw));
  parseSkillDocumentStrict(raw, skill.skillRoot, skill.skillFile);
  await validateRelativeReferences(raw, skill.skillRoot);

  return {
    frontmatter: mergedFrontmatter,
    content: rewrite.content.trim(),
    raw,
    changeSummary: rewrite.changeSummary,
    targetedProblems: rewrite.targetedProblems
  };
}

function extractActionableIssues(result: CheckRunResult): ImprovementBrief {
  const lintIssues = result.lint.issues
    .filter((issue) => issue.status !== "pass")
    .map((issue) => ({
      checkId: issue.checkId,
      title: issue.title,
      status: issue.status === "warn" ? ("warn" as const) : ("fail" as const),
      message: issue.message,
      suggestion: issue.suggestion,
      startLine: issue.startLine,
      endLine: issue.endLine
    }));

  const triggerFailures =
    result.trigger?.cases.filter((testCase) => !testCase.matched).map((testCase) => ({
      query: testCase.query,
      expected: testCase.expected,
      actual: testCase.actual,
      selectedCompetitor: testCase.selectedCompetitor,
      rawModelResponse: testCase.rawModelResponse
    })) ?? [];

  const evalFailures =
    result.eval?.results.flatMap((promptResult) =>
      promptResult.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => ({
          prompt: promptResult.prompt,
          assertion: assertion.assertion,
          evidence: assertion.evidence,
          source:
            assertion.source === "grader" || assertion.source === "tool"
              ? assertion.source
              : ("unknown" as const)
        }))
    ) ?? [];

  return {
    lintIssues,
    triggerFailures,
    evalFailures,
    triggerSuggestions: result.trigger?.suggestions ?? []
  };
}

function hasActionableProblems(brief: ImprovementBrief): boolean {
  return (
    brief.lintIssues.length > 0 ||
    brief.triggerFailures.length > 0 ||
    brief.evalFailures.length > 0 ||
    brief.triggerSuggestions.length > 0
  );
}

async function listSkillFiles(skillRoot: string): Promise<string[]> {
  const entries = await fs.readdir(skillRoot, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(skillRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSkillFiles(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(skillRoot, absolutePath).split(path.sep).join("/"));
    }
  }

  return files.sort();
}

async function requestRewrite(
  skill: ParsedSkill,
  baseline: CheckRunResult,
  brief: ImprovementBrief,
  provider: LanguageModelProvider,
  model: string
): Promise<z.infer<typeof improveRewriteSchema>> {
  const availableFiles = await listSkillFiles(skill.skillRoot);
  const systemPrompt = [
    "You rewrite Agent Skill files to improve measured quality.",
    "Return JSON only.",
    "Required format:",
    '{"frontmatter": {...}, "content": "...", "changeSummary": ["..."], "targetedProblems": ["..."]}',
    "The content field must contain only the markdown body of SKILL.md, without YAML frontmatter fences.",
    `Keep the skill name exactly '${skill.frontmatter.name}'.`,
    skill.frontmatter.license ? `Keep the license exactly '${skill.frontmatter.license}'.` : "Do not remove any valid existing frontmatter fields.",
    "Do not invent new scripts, assets, references, APIs, or tools.",
    "Only reference files that already exist under the skill root.",
    "Optimize for trigger clarity, explicit scope boundaries, concrete examples, safety guidance, and tool usage instructions."
  ].join(" ");

  const baselineTriggerF1 = baseline.trigger?.metrics.f1 ?? 0;
  const baselineEvalPassRate = calculateEvalAssertPassRate(baseline.eval);
  const userPrompt = [
    `Skill file: ${skill.skillFile}`,
    `Current trigger F1: ${baselineTriggerF1.toFixed(4)}`,
    `Current eval assertion pass rate: ${baselineEvalPassRate.toFixed(4)}`,
    `Lint failures: ${baseline.lint.summary.failures}`,
    `Lint warnings: ${baseline.lint.summary.warnings}`,
    "",
    "Available files under the skill root:",
    ...availableFiles.map((file) => `- ${file}`),
    "",
    "Current SKILL.md:",
    "```markdown",
    skill.raw,
    "```",
    "",
    "Actionable problems to fix:",
    JSON.stringify(brief, null, 2),
    "",
    "Rewrite the skill to address only these evidenced problems. Keep the instructions tight and practical."
  ].join("\n");

  const raw = await provider.sendMessage(systemPrompt, userPrompt, { model });
  const parsed = improveRewriteSchema.safeParse(extractJsonObject(raw));
  if (!parsed.success) {
    throw new Error(`Failed to parse improve output: ${parsed.error.issues[0]?.message ?? "invalid improve JSON"}`);
  }

  return parsed.data;
}

async function createVerificationDirectory(skillRoot: string, candidateRaw: string): Promise<{ tempRoot: string; skillPath: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skilltest-improve-"));
  const tempSkillRoot = path.join(tempRoot, path.basename(skillRoot));
  await fs.cp(skillRoot, tempSkillRoot, { recursive: true });
  await fs.writeFile(path.join(tempSkillRoot, "SKILL.md"), candidateRaw, "utf8");
  return {
    tempRoot,
    skillPath: tempSkillRoot
  };
}

function buildDelta(baseline: CheckRunResult, verification: CheckRunResult): ImproveDelta {
  const baselineTriggerF1 = baseline.trigger?.metrics.f1 ?? 0;
  const verificationTriggerF1 = verification.trigger?.metrics.f1 ?? 0;
  const baselineEvalPassRate = calculateEvalAssertPassRate(baseline.eval);
  const verificationEvalPassRate = calculateEvalAssertPassRate(verification.eval);

  const lintFailuresDelta = baseline.lint.summary.failures - verification.lint.summary.failures;
  const lintWarningsDelta = baseline.lint.summary.warnings - verification.lint.summary.warnings;
  const triggerF1Delta = verificationTriggerF1 - baselineTriggerF1;
  const evalPassRateDelta = verificationEvalPassRate - baselineEvalPassRate;

  const hasRegression =
    verification.lint.summary.failures > baseline.lint.summary.failures ||
    verification.lint.summary.warnings > baseline.lint.summary.warnings ||
    verificationTriggerF1 < baselineTriggerF1 ||
    verificationEvalPassRate < baselineEvalPassRate;

  const improved =
    verification.gates.overallPassed !== baseline.gates.overallPassed
      ? verification.gates.overallPassed
      : lintFailuresDelta > 0 || lintWarningsDelta > 0 || triggerF1Delta > 0 || evalPassRateDelta > 0;

  return {
    lintFailures: {
      before: baseline.lint.summary.failures,
      after: verification.lint.summary.failures,
      delta: lintFailuresDelta
    },
    lintWarnings: {
      before: baseline.lint.summary.warnings,
      after: verification.lint.summary.warnings,
      delta: lintWarningsDelta
    },
    triggerF1: {
      before: baselineTriggerF1,
      after: verificationTriggerF1,
      delta: triggerF1Delta
    },
    evalAssertPassRate: {
      before: baselineEvalPassRate,
      after: verificationEvalPassRate,
      delta: evalPassRateDelta
    },
    overallPassed: {
      before: baseline.gates.overallPassed,
      after: verification.gates.overallPassed
    },
    improved,
    hasRegression
  };
}

function normalizeVerificationTarget(result: CheckRunResult, target: string): CheckRunResult {
  return {
    ...result,
    target
  };
}

function buildBlockingReason(delta: ImproveDelta, verification: CheckRunResult): string | undefined {
  if (delta.hasRegression) {
    return "Candidate rewrite regressed one or more quality metrics on the frozen test set.";
  }

  if (!delta.improved) {
    return "Candidate rewrite did not produce a measurable improvement on the frozen test set.";
  }

  if (!verification.gates.overallPassed) {
    return "Candidate rewrite improved the skill but still failed the configured quality gates.";
  }

  return undefined;
}

async function maybeWriteOutput(outputPath: string, raw: string): Promise<string> {
  const absolutePath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, raw, "utf8");
  return absolutePath;
}

export async function runImprove(inputPath: string, options: RunImproveOptions): Promise<ImproveRunResult> {
  options.onStage?.("baseline");
  const baseline = await runCheck(inputPath, {
    provider: options.provider,
    model: options.model,
    graderModel: options.model,
    lintFailOn: options.lintFailOn,
    lintSuppress: options.lintSuppress,
    lintPlugins: options.lintPlugins,
    compare: options.compare,
    numQueries: options.numQueries,
    triggerSeed: options.triggerSeed,
    queries: options.queries,
    evalNumRuns: options.evalNumRuns,
    prompts: options.prompts,
    evalMaxToolIterations: options.evalMaxToolIterations,
    concurrency: options.concurrency,
    minF1: options.minF1,
    minAssertPassRate: options.minAssertPassRate,
    continueOnLintFail: true,
    verbose: options.verbose
  });

  if (!baseline.trigger || !baseline.eval) {
    return {
      target: inputPath,
      provider: options.provider.name,
      model: options.model,
      originalRaw: "",
      thresholds: {
        minF1: options.minF1,
        minAssertPassRate: options.minAssertPassRate
      },
      baseline,
      candidate: null,
      verification: null,
      delta: null,
      applied: false,
      blockedReason:
        baseline.triggerSkippedReason ??
        baseline.evalSkippedReason ??
        "Improve requires a strictly parseable skill so trigger and eval can be frozen."
    };
  }

  const skill = await parseSkillStrict(inputPath);
  const brief = extractActionableIssues(baseline);
  if (!hasActionableProblems(brief)) {
    return {
      target: inputPath,
      provider: options.provider.name,
      model: options.model,
      originalRaw: skill.raw,
      thresholds: {
        minF1: options.minF1,
        minAssertPassRate: options.minAssertPassRate
      },
      baseline,
      candidate: null,
      verification: null,
      delta: null,
      applied: false,
      blockedReason: "No actionable failures, warnings, or mismatches were found to improve."
    };
  }

  options.onStage?.("generate");
  const rewrite = await requestRewrite(skill, baseline, brief, options.provider, options.model);

  options.onStage?.("validate");
  const candidate = await buildCandidate(skill, rewrite);

  if (candidate.raw === skill.raw) {
    return {
      target: inputPath,
      provider: options.provider.name,
      model: options.model,
      originalRaw: skill.raw,
      thresholds: {
        minF1: options.minF1,
        minAssertPassRate: options.minAssertPassRate
      },
      baseline,
      candidate,
      verification: null,
      delta: null,
      applied: false,
      blockedReason: "Candidate rewrite produced no changes."
    };
  }

  options.onStage?.("verify");
  const verificationDirectory = await createVerificationDirectory(skill.skillRoot, candidate.raw);
  let verification: CheckRunResult;

  try {
    verification = normalizeVerificationTarget(
      await runCheck(verificationDirectory.skillPath, {
        provider: options.provider,
        model: options.model,
        graderModel: options.model,
        lintFailOn: options.lintFailOn,
        lintSuppress: options.lintSuppress,
        lintPlugins: options.lintPlugins,
        compare: options.compare,
        numQueries: baseline.trigger.queries.length,
        triggerSeed: options.triggerSeed,
        queries: baseline.trigger.queries,
        evalNumRuns: baseline.eval.prompts.length,
        prompts: baseline.eval.prompts,
        evalMaxToolIterations: options.evalMaxToolIterations,
        concurrency: options.concurrency,
        minF1: options.minF1,
        minAssertPassRate: options.minAssertPassRate,
        continueOnLintFail: true,
        verbose: options.verbose
      }),
      inputPath
    );
  } finally {
    await fs.rm(verificationDirectory.tempRoot, { recursive: true, force: true });
  }

  const delta = buildDelta(baseline, verification);
  const blockedReason = buildBlockingReason(delta, verification);
  let applied = false;
  let outputPath: string | undefined;

  if (!blockedReason) {
    if (options.outputPath) {
      options.onStage?.("write");
      outputPath = await maybeWriteOutput(options.outputPath, candidate.raw);
    }

    if (options.apply) {
      options.onStage?.("write");
      await fs.writeFile(skill.skillFile, candidate.raw, "utf8");
      applied = true;
    }
  }

  return {
    target: inputPath,
    provider: options.provider.name,
    model: options.model,
    originalRaw: skill.raw,
    thresholds: {
      minF1: options.minF1,
      minAssertPassRate: options.minAssertPassRate
    },
    baseline,
    candidate,
    verification,
    delta,
    applied,
    ...(outputPath ? { outputPath } : {}),
    ...(blockedReason ? { blockedReason } : {})
  };
}

export { improveRewriteSchema, extractActionableIssues as buildImprovementBrief };
