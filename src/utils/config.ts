import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { resolveSkillPath } from "../core/skill-parser.js";
import { ProviderName } from "../providers/types.js";
import { pathExists } from "./fs.js";

const providerNameSchema = z.enum(["anthropic", "openai"]);
const lintFailOnSchema = z.enum(["error", "warn"]);

const lintConfigSchema = z
  .object({
    failOn: lintFailOnSchema.optional(),
    suppress: z.array(z.string().min(1)).optional()
  })
  .strict();

const triggerConfigSchema = z
  .object({
    numQueries: z
      .number()
      .int()
      .min(2)
      .refine((value) => value % 2 === 0, "trigger.numQueries must be an even number."),
    threshold: z.number().min(0).max(1).optional(),
    seed: z.number().int().optional()
  })
  .strict()
  .partial();

const evalConfigSchema = z
  .object({
    numRuns: z.number().int().min(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    promptFile: z.string().min(1).optional(),
    assertionsFile: z.string().min(1).optional()
  })
  .strict()
  .partial();

export const skilltestConfigSchema = z
  .object({
    provider: providerNameSchema.optional(),
    model: z.string().min(1).optional(),
    json: z.boolean().optional(),
    lint: lintConfigSchema.optional(),
    trigger: triggerConfigSchema.optional(),
    eval: evalConfigSchema.optional()
  })
  .strict();

const resolvedSkilltestConfigSchema = z.object({
  provider: providerNameSchema,
  model: z.string().min(1),
  json: z.boolean(),
  lint: z.object({
    failOn: lintFailOnSchema,
    suppress: z.array(z.string().min(1))
  }),
  trigger: z.object({
    numQueries: z.number().int().min(2).refine((value) => value % 2 === 0, "trigger.numQueries must be an even number."),
    threshold: z.number().min(0).max(1),
    seed: z.number().int().optional()
  }),
  eval: z.object({
    numRuns: z.number().int().min(1),
    threshold: z.number().min(0).max(1),
    promptFile: z.string().min(1).optional(),
    assertionsFile: z.string().min(1).optional()
  })
});

export type SkilltestConfigFile = z.infer<typeof skilltestConfigSchema>;
export type LintFailOn = z.infer<typeof lintFailOnSchema>;
export type ResolvedSkilltestConfig = z.infer<typeof resolvedSkilltestConfigSchema>;

export interface ResolvedConfigContext {
  configFile: SkilltestConfigFile | null;
  config: ResolvedSkilltestConfig;
  sourcePath: string | null;
  sourceDirectory: string;
}

interface LoadedConfigFile {
  configFile: SkilltestConfigFile;
  sourcePath: string;
  sourceDirectory: string;
}

export const DEFAULT_SKILLTEST_CONFIG: ResolvedSkilltestConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
  json: false,
  lint: {
    failOn: "error",
    suppress: []
  },
  trigger: {
    numQueries: 20,
    threshold: 0.8
  },
  eval: {
    numRuns: 5,
    threshold: 0.9
  }
};

function formatIssuePath(issuePath: Array<string | number>): string {
  if (issuePath.length === 0) {
    return "root";
  }
  return issuePath.map(String).join(".");
}

function buildConfigValidationError(error: z.ZodError, sourceLabel: string): Error {
  const issue = error.issues[0];
  const issuePath = formatIssuePath(issue?.path ?? []);
  const issueMessage = issue?.message ?? "Invalid config value.";
  return new Error(`Invalid skilltest config in ${sourceLabel} at ${issuePath}: ${issueMessage}`);
}

async function readJsonObject(filePath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label}: ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label}: ${message}`);
  }
}

async function loadConfigFromJsonFile(filePath: string): Promise<LoadedConfigFile | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  const raw = await readJsonObject(filePath, filePath);
  const parsed = skilltestConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw buildConfigValidationError(parsed.error, filePath);
  }

  return {
    configFile: parsed.data,
    sourcePath: filePath,
    sourceDirectory: path.dirname(filePath)
  };
}

async function loadConfigFromNearestPackageJson(startDirectory: string): Promise<LoadedConfigFile | null> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const packageJsonPath = path.join(currentDirectory, "package.json");
    if (await pathExists(packageJsonPath)) {
      const raw = await readJsonObject(packageJsonPath, packageJsonPath);
      const packageJsonSchema = z
        .object({
          skilltestrc: skilltestConfigSchema.optional()
        })
        .passthrough();
      const parsed = packageJsonSchema.safeParse(raw);
      if (!parsed.success) {
        throw buildConfigValidationError(parsed.error, `${packageJsonPath}#skilltestrc`);
      }

      if (!parsed.data.skilltestrc) {
        return null;
      }

      return {
        configFile: parsed.data.skilltestrc,
        sourcePath: packageJsonPath,
        sourceDirectory: currentDirectory
      };
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
}

async function resolveSkillDirectoryConfig(targetPath?: string): Promise<LoadedConfigFile | null> {
  if (!targetPath) {
    return null;
  }

  try {
    const { skillRoot } = await resolveSkillPath(targetPath);
    return loadConfigFromJsonFile(path.join(skillRoot, ".skilltestrc"));
  } catch {
    return null;
  }
}

function resolveConfigRelativePath(baseDirectory: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return path.resolve(baseDirectory, value);
}

export function mergeConfigLayers(
  configFile: SkilltestConfigFile = {},
  cliFlags: SkilltestConfigFile = {},
  baseDirectory = process.cwd()
): ResolvedSkilltestConfig {
  const merged = {
    provider: cliFlags.provider ?? configFile.provider ?? DEFAULT_SKILLTEST_CONFIG.provider,
    model: cliFlags.model ?? configFile.model ?? DEFAULT_SKILLTEST_CONFIG.model,
    json: cliFlags.json ?? configFile.json ?? DEFAULT_SKILLTEST_CONFIG.json,
    lint: {
      failOn: cliFlags.lint?.failOn ?? configFile.lint?.failOn ?? DEFAULT_SKILLTEST_CONFIG.lint.failOn,
      suppress: cliFlags.lint?.suppress ?? configFile.lint?.suppress ?? DEFAULT_SKILLTEST_CONFIG.lint.suppress
    },
    trigger: {
      numQueries:
        cliFlags.trigger?.numQueries ?? configFile.trigger?.numQueries ?? DEFAULT_SKILLTEST_CONFIG.trigger.numQueries,
      threshold:
        cliFlags.trigger?.threshold ?? configFile.trigger?.threshold ?? DEFAULT_SKILLTEST_CONFIG.trigger.threshold,
      seed: cliFlags.trigger?.seed ?? configFile.trigger?.seed
    },
    eval: {
      numRuns: cliFlags.eval?.numRuns ?? configFile.eval?.numRuns ?? DEFAULT_SKILLTEST_CONFIG.eval.numRuns,
      threshold: cliFlags.eval?.threshold ?? configFile.eval?.threshold ?? DEFAULT_SKILLTEST_CONFIG.eval.threshold,
      promptFile: resolveConfigRelativePath(
        baseDirectory,
        cliFlags.eval?.promptFile ?? configFile.eval?.promptFile ?? DEFAULT_SKILLTEST_CONFIG.eval.promptFile
      ),
      assertionsFile: resolveConfigRelativePath(
        baseDirectory,
        cliFlags.eval?.assertionsFile ?? configFile.eval?.assertionsFile ?? DEFAULT_SKILLTEST_CONFIG.eval.assertionsFile
      )
    }
  };

  return resolvedSkilltestConfigSchema.parse(merged);
}

function getTypedOptionValue<T extends string | number | boolean>(command: Command, key: string): T | undefined {
  const options = command.optsWithGlobals<Record<string, unknown>>();
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  return value as T;
}

export function extractCliConfigOverrides(command: Command): SkilltestConfigFile {
  const overrides: SkilltestConfigFile = {};

  if (command.getOptionValueSourceWithGlobals("json") === "cli") {
    overrides.json = Boolean(getTypedOptionValue<boolean>(command, "json"));
  }

  if (command.getOptionValueSource("provider") === "cli") {
    overrides.provider = getTypedOptionValue<ProviderName>(command, "provider");
  }

  if (command.getOptionValueSource("model") === "cli") {
    overrides.model = getTypedOptionValue<string>(command, "model");
  }

  if ((command.name() === "trigger" || command.name() === "check") && command.getOptionValueSource("numQueries") === "cli") {
    overrides.trigger = {
      ...overrides.trigger,
      numQueries: getTypedOptionValue<number>(command, "numQueries")
    };
  }

  if (command.name() === "check" && command.getOptionValueSource("minF1") === "cli") {
    overrides.trigger = {
      ...overrides.trigger,
      threshold: getTypedOptionValue<number>(command, "minF1")
    };
  }

  if (command.name() === "check" && command.getOptionValueSource("minAssertPassRate") === "cli") {
    overrides.eval = {
      ...overrides.eval,
      threshold: getTypedOptionValue<number>(command, "minAssertPassRate")
    };
  }

  const parsed = skilltestConfigSchema.safeParse(overrides);
  if (!parsed.success) {
    throw buildConfigValidationError(parsed.error, "CLI flags");
  }
  return parsed.data;
}

export async function resolveConfigContext(targetPath: string | undefined, cliFlags: SkilltestConfigFile): Promise<ResolvedConfigContext> {
  const cwd = process.cwd();
  const skillDirectoryConfig = await resolveSkillDirectoryConfig(targetPath);
  if (skillDirectoryConfig) {
    return {
      configFile: skillDirectoryConfig.configFile,
      ...skillDirectoryConfig,
      config: mergeConfigLayers(skillDirectoryConfig.configFile, cliFlags, skillDirectoryConfig.sourceDirectory)
    };
  }

  const cwdConfigPath = path.join(cwd, ".skilltestrc");
  const cwdConfig = await loadConfigFromJsonFile(cwdConfigPath);
  if (cwdConfig) {
    return {
      configFile: cwdConfig.configFile,
      ...cwdConfig,
      config: mergeConfigLayers(cwdConfig.configFile, cliFlags, cwdConfig.sourceDirectory)
    };
  }

  const packageJsonConfig = await loadConfigFromNearestPackageJson(cwd);
  if (packageJsonConfig) {
    return {
      configFile: packageJsonConfig.configFile,
      ...packageJsonConfig,
      config: mergeConfigLayers(packageJsonConfig.configFile, cliFlags, packageJsonConfig.sourceDirectory)
    };
  }

  return {
    configFile: null,
    config: mergeConfigLayers({}, cliFlags, cwd),
    sourcePath: null,
    sourceDirectory: cwd
  };
}

export function resolveApiKey(provider: ProviderName, override?: string): string {
  if (override && override.trim() !== "") {
    return override.trim();
  }

  if (provider === "anthropic") {
    const envValue = process.env.ANTHROPIC_API_KEY?.trim();
    if (envValue) {
      return envValue;
    }
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY environment variable or pass --api-key flag."
    );
  }

  const envValue = process.env.OPENAI_API_KEY?.trim();
  if (envValue) {
    return envValue;
  }
  throw new Error("No OpenAI API key found. Set OPENAI_API_KEY environment variable or pass --api-key flag.");
}
