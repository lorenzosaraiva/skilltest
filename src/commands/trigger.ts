import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runTriggerTest } from "../core/trigger-tester.js";
import { parseSkillStrict } from "../core/skill-parser.js";
import { createProvider } from "../providers/index.js";
import { renderTriggerReport } from "../reporters/terminal.js";
import { getGlobalCliOptions, getResolvedConfig, loadTriggerQueriesFile, writeError, writeResult } from "./common.js";
import { writeJsonFile } from "../utils/fs.js";

const triggerCliSchema = z.object({
  queries: z.string().optional(),
  saveQueries: z.string().optional(),
  seed: z.number().int().optional(),
  verbose: z.boolean().optional(),
  apiKey: z.string().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

interface TriggerCommandOptions {
  json: boolean;
  color: boolean;
  model: string;
  provider: "anthropic" | "openai";
  queries?: string;
  numQueries: number;
  saveQueries?: string;
  seed?: number;
  verbose: boolean;
  apiKey?: string;
}

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }
  return model;
}

function renderTriggerOutputWithSeed(output: string, seed?: number): string {
  if (seed === undefined) {
    return output;
  }
  return `${output}\nSeed: ${seed}`;
}

async function handleTriggerCommand(targetPath: string, options: TriggerCommandOptions): Promise<void> {
  const spinner = options.json || !process.stdout.isTTY ? null : ora("Preparing trigger evaluation...").start();

  try {
    if (spinner) {
      spinner.text = "Parsing skill...";
    }
    const skill = await parseSkillStrict(targetPath);

    if (spinner) {
      spinner.text = "Initializing model provider...";
    }
    const provider = createProvider(options.provider, options.apiKey);

    let queries = undefined;
    if (options.queries) {
      if (spinner) {
        spinner.text = "Loading custom trigger queries...";
      }
      queries = await loadTriggerQueriesFile(options.queries);
    }

    if (spinner) {
      spinner.text = "Running trigger simulations...";
    }
    const model = resolveModel(options.provider, options.model);
    const result = await runTriggerTest(skill, {
      model,
      provider,
      queries,
      numQueries: options.numQueries,
      seed: options.seed,
      verbose: options.verbose
    });

    if (options.saveQueries) {
      await writeJsonFile(options.saveQueries, result.queries);
    }

    spinner?.stop();
    if (options.json) {
      writeResult(result, true);
    } else {
      writeResult(renderTriggerOutputWithSeed(renderTriggerReport(result, options.color, options.verbose), result.seed), false);
    }
  } catch (error) {
    spinner?.stop();
    writeError(error, options.json);
    process.exitCode = 2;
  }
}

export function registerTriggerCommand(program: Command): void {
  program
    .command("trigger")
    .description("Evaluate whether a skill description triggers correctly.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--model <model>", "Model to use")
    .option("--provider <provider>", "LLM provider: anthropic|openai")
    .option("--queries <path>", "Path to custom test queries JSON")
    .option("--num-queries <n>", "Number of auto-generated queries", (value) => Number.parseInt(value, 10))
    .option("--seed <number>", "RNG seed for reproducible results", (value) => Number.parseInt(value, 10))
    .option("--save-queries <path>", "Save generated queries to a JSON file")
    .option("--api-key <key>", "API key override")
    .option("--verbose", "Show full model decisions")
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);
      const parsedCli = triggerCliSchema.safeParse(command.opts());
      if (!parsedCli.success) {
        writeError(new Error(parsedCli.error.issues[0]?.message ?? "Invalid trigger options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      await handleTriggerCommand(targetPath, {
        ...globalOptions,
        model: config.model,
        provider: config.provider,
        queries: parsedCli.data.queries,
        numQueries: config.trigger.numQueries,
        saveQueries: parsedCli.data.saveQueries,
        seed: parsedCli.data.seed ?? config.trigger.seed,
        verbose: Boolean(parsedCli.data.verbose),
        apiKey: parsedCli.data.apiKey
      });
    });
}
