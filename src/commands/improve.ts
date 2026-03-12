import fs from "node:fs/promises";
import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runImprove } from "../core/improver.js";
import { createProvider } from "../providers/index.js";
import {
  getGlobalCliOptions,
  getResolvedConfig,
  loadConfiguredEvalPrompts,
  loadEvalPromptsJson,
  loadTriggerQueriesFile,
  writeError,
  writeResult
} from "./common.js";
import { renderImproveReport } from "../reporters/terminal.js";
import { writeJsonFile } from "../utils/fs.js";

const improveCliSchema = z.object({
  apiKey: z.string().optional(),
  queries: z.string().optional(),
  compare: z.array(z.string().min(1)).optional(),
  seed: z.number().int().optional(),
  prompts: z.string().optional(),
  plugin: z.array(z.string().min(1)).optional(),
  concurrency: z.number().int().min(1).optional(),
  output: z.string().optional(),
  saveResults: z.string().optional(),
  apply: z.boolean().optional(),
  verbose: z.boolean().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

interface ImproveCommandOptions {
  json: boolean;
  color: boolean;
  provider: "anthropic" | "openai";
  model: string;
  apiKey?: string;
  queries?: string;
  compare: string[];
  numQueries: number;
  prompts?: string;
  minF1: number;
  minAssertPassRate: number;
  numRuns: number;
  maxToolIterations: number;
  concurrency: number;
  lintFailOn: "error" | "warn";
  lintSuppress: string[];
  lintPlugins: string[];
  triggerSeed?: number;
  output?: string;
  saveResults?: string;
  apply: boolean;
  verbose: boolean;
}

function collectPluginPaths(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }

  return model;
}

async function handleImproveCommand(targetPath: string, options: ImproveCommandOptions, command: Command): Promise<void> {
  const spinner = options.json || !process.stdout.isTTY ? null : ora("Preparing improvement run...").start();

  try {
    if (spinner) {
      spinner.text = "Initializing model provider...";
    }
    const provider = createProvider(options.provider, options.apiKey);

    let queries = undefined;
    if (options.queries) {
      if (spinner) {
        spinner.text = "Loading frozen trigger queries...";
      }
      queries = await loadTriggerQueriesFile(options.queries);
    }

    let prompts = undefined;
    if (options.prompts) {
      if (spinner) {
        spinner.text = "Loading eval prompts...";
      }
      prompts = await loadEvalPromptsJson(options.prompts);
    } else {
      prompts = await loadConfiguredEvalPrompts(command);
    }

    const model = resolveModel(options.provider, options.model);
    const result = await runImprove(targetPath, {
      provider,
      model,
      lintFailOn: options.lintFailOn,
      lintSuppress: options.lintSuppress,
      lintPlugins: options.lintPlugins,
      compare: options.compare,
      numQueries: options.numQueries,
      triggerSeed: options.triggerSeed,
      queries,
      prompts,
      evalNumRuns: options.numRuns,
      evalMaxToolIterations: options.maxToolIterations,
      minF1: options.minF1,
      minAssertPassRate: options.minAssertPassRate,
      concurrency: options.concurrency,
      apply: options.apply,
      outputPath: options.output,
      verbose: options.verbose,
      onStage: (stage) => {
        if (!spinner) {
          return;
        }

        if (stage === "baseline") {
          spinner.text = "Running baseline check...";
        } else if (stage === "generate") {
          spinner.text = "Generating candidate rewrite...";
        } else if (stage === "validate") {
          spinner.text = "Validating candidate rewrite...";
        } else if (stage === "verify") {
          spinner.text = "Verifying candidate against frozen test inputs...";
        } else if (stage === "write") {
          spinner.text = options.apply ? "Writing improved SKILL.md..." : "Writing candidate output...";
        }
      }
    });

    if (options.saveResults) {
      await writeJsonFile(options.saveResults, result);
    }

    spinner?.stop();
    if (options.json) {
      writeResult(result, true);
    } else {
      writeResult(renderImproveReport(result, options.color, options.verbose), false);
    }

    process.exitCode = result.blockedReason ? 1 : 0;
  } catch (error) {
    spinner?.stop();
    writeError(error, options.json);
    process.exitCode = 2;
  }
}

export function registerImproveCommand(program: Command): void {
  program
    .command("improve")
    .description("Rewrite SKILL.md, verify it on frozen test inputs, and optionally apply it.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--provider <provider>", "LLM provider: anthropic|openai")
    .option("--model <model>", "Model for baseline, rewrite, and verification runs")
    .option("--api-key <key>", "API key override")
    .option("--queries <path>", "Path to custom trigger queries JSON")
    .option("--compare <path...>", "Path(s) to sibling skill directories to include as competitors")
    .option("--num-queries <n>", "Number of auto-generated trigger queries", (value) => Number.parseInt(value, 10))
    .option("--seed <number>", "RNG seed for reproducible trigger results", (value) => Number.parseInt(value, 10))
    .option("--prompts <path>", "Path to eval prompts JSON")
    .option("--plugin <path>", "Load a custom lint plugin file", collectPluginPaths, [])
    .option("--concurrency <n>", "Maximum in-flight trigger/eval tasks", (value) => Number.parseInt(value, 10))
    .option("--output <path>", "Write the verified candidate SKILL.md to a separate file")
    .option("--save-results <path>", "Save the full improve result JSON")
    .option("--min-f1 <n>", "Minimum required trigger F1 score (0-1)", (value) => Number.parseFloat(value))
    .option("--min-assert-pass-rate <n>", "Minimum required eval assertion pass rate (0-1)", (value) =>
      Number.parseFloat(value)
    )
    .option("--apply", "Apply the verified rewrite to the source SKILL.md")
    .option("--verbose", "Include detailed baseline and verification reports")
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);
      const parsedCli = improveCliSchema.safeParse(command.opts());
      if (!parsedCli.success) {
        writeError(new Error(parsedCli.error.issues[0]?.message ?? "Invalid improve options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      await handleImproveCommand(
        targetPath,
        {
          ...globalOptions,
          provider: config.provider,
          model: config.model,
          apiKey: parsedCli.data.apiKey,
          queries: parsedCli.data.queries,
          compare: config.trigger.compare,
          numQueries: config.trigger.numQueries,
          prompts: parsedCli.data.prompts,
          minF1: config.trigger.threshold,
          minAssertPassRate: config.eval.threshold,
          numRuns: config.eval.numRuns,
          maxToolIterations: config.eval.maxToolIterations,
          concurrency: config.concurrency,
          lintFailOn: config.lint.failOn,
          lintSuppress: config.lint.suppress,
          lintPlugins: config.lint.plugins,
          triggerSeed: parsedCli.data.seed ?? config.trigger.seed,
          output: parsedCli.data.output,
          saveResults: parsedCli.data.saveResults,
          apply: Boolean(parsedCli.data.apply),
          verbose: Boolean(parsedCli.data.verbose)
        },
        command
      );
    });
}
