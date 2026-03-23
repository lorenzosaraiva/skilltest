import fs from "node:fs/promises";
import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runRouteTest } from "../core/route-tester.js";
import { createProvider } from "../providers/index.js";
import { renderRouteHtml } from "../reporters/html.js";
import { renderRouteReport } from "../reporters/terminal.js";
import { getGlobalCliOptions, getResolvedConfig, writeError, writeResult } from "./common.js";
import { writeJsonFile } from "../utils/fs.js";

const routeCliSchema = z.object({
  numQueries: z.number().int().min(1).optional(),
  conflictThreshold: z.number().min(0).max(1).optional(),
  saveQueries: z.string().optional(),
  seed: z.number().int().optional(),
  concurrency: z.number().int().min(1).optional(),
  html: z.string().optional(),
  verbose: z.boolean().optional(),
  apiKey: z.string().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

interface RouteCommandOptions {
  json: boolean;
  color: boolean;
  model: string;
  provider: "anthropic" | "openai";
  numQueriesPerSkill: number;
  conflictThreshold: number;
  saveQueries?: string;
  seed?: number;
  concurrency: number;
  html?: string;
  verbose: boolean;
  apiKey?: string;
}

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }
  return model;
}

async function handleRouteCommand(skillDir: string, options: RouteCommandOptions): Promise<void> {
  const spinner = options.json || !process.stdout.isTTY ? null : ora("Preparing route evaluation...").start();

  try {
    if (spinner) spinner.text = "Initializing model provider...";
    const provider = createProvider(options.provider, options.apiKey);

    if (spinner) spinner.text = "Running route simulations...";
    const model = resolveModel(options.provider, options.model);
    const result = await runRouteTest(skillDir, {
      model,
      provider,
      numQueriesPerSkill: options.numQueriesPerSkill,
      conflictThreshold: options.conflictThreshold,
      seed: options.seed,
      concurrency: options.concurrency,
      verbose: options.verbose
    });

    if (options.saveQueries) {
      await writeJsonFile(
        options.saveQueries,
        result.cases.map((c) => ({ query: c.query, targetSkill: c.targetSkill }))
      );
    }

    spinner?.stop();
    if (options.json) {
      writeResult(result, true);
    } else {
      writeResult(renderRouteReport(result, options.color, options.verbose), false);
    }

    if (options.html) {
      await fs.writeFile(options.html, renderRouteHtml(result), "utf8");
    }
  } catch (error) {
    spinner?.stop();
    writeError(error, options.json);
    process.exitCode = 2;
  }
}

export function registerRouteCommand(program: Command): void {
  program
    .command("route")
    .description("Validate multi-skill routing across all skills in a directory.")
    .argument("<skillDir>", "Directory containing skill subdirectories with SKILL.md files")
    .option("--model <model>", "Model to use")
    .option("--provider <provider>", "LLM provider: anthropic|openai")
    .option("--num-queries <n>", "Queries per skill (default: 10)", (value) => Number.parseInt(value, 10))
    .option("--conflict-threshold <n>", "Bleed fraction to flag as conflict (default: 0.1)", (value) => Number.parseFloat(value))
    .option("--seed <number>", "RNG seed for reproducibility metadata", (value) => Number.parseInt(value, 10))
    .option("--concurrency <n>", "Maximum in-flight requests", (value) => Number.parseInt(value, 10))
    .option("--html <path>", "Write an HTML report to the given file path")
    .option("--save-queries <path>", "Save generated queries as JSON")
    .option("--api-key <key>", "API key override")
    .option("--verbose", "Show raw model responses")
    .action(async (skillDir: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);
      const parsedCli = routeCliSchema.safeParse(command.opts());
      if (!parsedCli.success) {
        writeError(new Error(parsedCli.error.issues[0]?.message ?? "Invalid route options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      await handleRouteCommand(skillDir, {
        ...globalOptions,
        model: config.model,
        provider: config.provider,
        numQueriesPerSkill: parsedCli.data.numQueries ?? 10,
        conflictThreshold: parsedCli.data.conflictThreshold ?? 0.1,
        saveQueries: parsedCli.data.saveQueries,
        seed: parsedCli.data.seed,
        concurrency: parsedCli.data.concurrency ?? config.concurrency,
        html: parsedCli.data.html,
        verbose: Boolean(parsedCli.data.verbose),
        apiKey: parsedCli.data.apiKey
      });
    });
}
