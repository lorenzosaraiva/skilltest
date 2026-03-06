import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runCheck } from "../core/check-runner.js";
import { createProvider } from "../providers/index.js";
import { renderCheckReport } from "../reporters/terminal.js";
import {
  getGlobalCliOptions,
  getResolvedConfig,
  loadConfiguredEvalPrompts,
  loadEvalPromptsJson,
  loadTriggerQueriesFile,
  writeError,
  writeResult
} from "./common.js";
import { writeJsonFile } from "../utils/fs.js";

const checkCliSchema = z.object({
  graderModel: z.string().optional(),
  apiKey: z.string().optional(),
  queries: z.string().optional(),
  prompts: z.string().optional(),
  saveResults: z.string().optional(),
  continueOnLintFail: z.boolean().optional(),
  verbose: z.boolean().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

interface CheckCommandOptions {
  json: boolean;
  color: boolean;
  provider: "anthropic" | "openai";
  model: string;
  graderModel?: string;
  apiKey?: string;
  queries?: string;
  numQueries: number;
  prompts?: string;
  minF1: number;
  minAssertPassRate: number;
  numRuns: number;
  lintFailOn: "error" | "warn";
  lintSuppress: string[];
  triggerSeed?: number;
  saveResults?: string;
  continueOnLintFail: boolean;
  verbose: boolean;
}

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }
  return model;
}

async function handleCheckCommand(targetPath: string, options: CheckCommandOptions, command: Command): Promise<void> {
  const spinner = options.json || !process.stdout.isTTY ? null : ora("Preparing check run...").start();

  try {
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
    const graderModel = options.graderModel ?? model;

    const result = await runCheck(targetPath, {
      provider,
      model,
      graderModel,
      lintFailOn: options.lintFailOn,
      lintSuppress: options.lintSuppress,
      queries,
      numQueries: options.numQueries,
      triggerSeed: options.triggerSeed,
      prompts,
      evalNumRuns: options.numRuns,
      minF1: options.minF1,
      minAssertPassRate: options.minAssertPassRate,
      continueOnLintFail: options.continueOnLintFail,
      verbose: options.verbose,
      onStage: (stage) => {
        if (!spinner) {
          return;
        }
        if (stage === "lint") {
          spinner.text = "Running lint checks...";
        } else if (stage === "parse") {
          spinner.text = "Parsing skill for model evaluations...";
        } else if (stage === "trigger") {
          spinner.text = "Running trigger test suite...";
        } else if (stage === "eval") {
          spinner.text = "Running end-to-end eval suite...";
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
      writeResult(renderCheckReport(result, options.color, options.verbose), false);
    }

    process.exitCode = result.gates.overallPassed ? 0 : 1;
  } catch (error) {
    spinner?.stop();
    writeError(error, options.json);
    process.exitCode = 2;
  }
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run lint + trigger + eval with threshold-based quality gates.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--provider <provider>", "LLM provider: anthropic|openai")
    .option("--model <model>", "Model for trigger/eval runs")
    .option("--grader-model <model>", "Model used for grading (defaults to --model)")
    .option("--api-key <key>", "API key override")
    .option("--queries <path>", "Path to custom trigger queries JSON")
    .option("--num-queries <n>", "Number of auto-generated trigger queries", (value) => Number.parseInt(value, 10))
    .option("--prompts <path>", "Path to eval prompts JSON")
    .option("--min-f1 <n>", "Minimum required trigger F1 score (0-1)", (value) => Number.parseFloat(value))
    .option("--min-assert-pass-rate <n>", "Minimum required eval assertion pass rate (0-1)", (value) => Number.parseFloat(value))
    .option("--save-results <path>", "Save combined check results to JSON")
    .option("--continue-on-lint-fail", "Continue trigger/eval stages even when lint has failures")
    .option("--verbose", "Show detailed trigger/eval output sections")
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);
      const parsedCli = checkCliSchema.safeParse(command.opts());
      if (!parsedCli.success) {
        writeError(new Error(parsedCli.error.issues[0]?.message ?? "Invalid check options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      await handleCheckCommand(
        targetPath,
        {
          ...globalOptions,
          provider: config.provider,
          model: config.model,
          graderModel: parsedCli.data.graderModel,
          apiKey: parsedCli.data.apiKey,
          queries: parsedCli.data.queries,
          numQueries: config.trigger.numQueries,
          prompts: parsedCli.data.prompts,
          minF1: config.trigger.threshold,
          minAssertPassRate: config.eval.threshold,
          numRuns: config.eval.numRuns,
          lintFailOn: config.lint.failOn,
          lintSuppress: config.lint.suppress,
          triggerSeed: config.trigger.seed,
          saveResults: parsedCli.data.saveResults,
          continueOnLintFail: Boolean(parsedCli.data.continueOnLintFail),
          verbose: Boolean(parsedCli.data.verbose)
        },
        command
      );
    });
}
