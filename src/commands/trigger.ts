import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runTriggerTest, triggerQueryArraySchema } from "../core/trigger-tester.js";
import { parseSkillStrict } from "../core/skill-parser.js";
import { createProvider } from "../providers/index.js";
import { ProviderName } from "../providers/types.js";
import { renderTriggerReport } from "../reporters/terminal.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import { getGlobalCliOptions, writeError, writeResult } from "./common.js";

const triggerOptionsSchema = z.object({
  model: z.string(),
  provider: z.enum(["anthropic", "openai"]),
  queries: z.string().optional(),
  numQueries: z.number().int().min(2),
  saveQueries: z.string().optional(),
  verbose: z.boolean().optional(),
  apiKey: z.string().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }
  return model;
}

export function registerTriggerCommand(program: Command): void {
  program
    .command("trigger")
    .description("Evaluate whether a skill description triggers correctly.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--model <model>", "Model to use", DEFAULT_ANTHROPIC_MODEL)
    .option("--provider <provider>", "LLM provider: anthropic|openai", "anthropic")
    .option("--queries <path>", "Path to custom test queries JSON")
    .option("--num-queries <n>", "Number of auto-generated queries", (value) => Number.parseInt(value, 10), 20)
    .option("--save-queries <path>", "Save generated queries to a JSON file")
    .option("--api-key <key>", "API key override")
    .option("--verbose", "Show full model decisions")
    .action(async (targetPath: string, commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const parsedOptions = triggerOptionsSchema.safeParse(commandOptions);
      if (!parsedOptions.success) {
        writeError(new Error(parsedOptions.error.issues[0]?.message ?? "Invalid trigger options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      const options = parsedOptions.data;
      const spinner = globalOptions.json || !process.stdout.isTTY ? null : ora("Preparing trigger evaluation...").start();

      try {
        if (options.numQueries % 2 !== 0) {
          throw new Error("--num-queries must be an even number so the suite can split should/should-not trigger cases.");
        }

        if (spinner) {
          spinner.text = "Parsing skill...";
        }
        const skill = await parseSkillStrict(targetPath);

        if (spinner) {
          spinner.text = "Initializing model provider...";
        }
        const provider = createProvider(options.provider as ProviderName, options.apiKey);

        let queries = undefined;
        if (options.queries) {
          if (spinner) {
            spinner.text = "Loading custom trigger queries...";
          }
          const loaded = await readJsonFile<unknown>(options.queries);
          const parsedQueries = triggerQueryArraySchema.safeParse(loaded);
          if (!parsedQueries.success) {
            throw new Error(`Invalid --queries JSON: ${parsedQueries.error.issues[0]?.message ?? "unknown format issue"}`);
          }
          queries = parsedQueries.data;
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
          verbose: Boolean(options.verbose)
        });

        if (options.saveQueries) {
          await writeJsonFile(options.saveQueries, result.queries);
        }

        spinner?.stop();
        if (globalOptions.json) {
          writeResult(result, true);
        } else {
          writeResult(renderTriggerReport(result, globalOptions.color, Boolean(options.verbose)), false);
        }
      } catch (error) {
        spinner?.stop();
        writeError(error, globalOptions.json);
        process.exitCode = 2;
      }
    });
}
