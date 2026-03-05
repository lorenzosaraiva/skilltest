import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runCheck } from "../core/check-runner.js";
import { evalPromptArraySchema } from "../core/eval-runner.js";
import { triggerQueryArraySchema } from "../core/trigger-tester.js";
import { createProvider } from "../providers/index.js";
import { ProviderName } from "../providers/types.js";
import { renderCheckReport } from "../reporters/terminal.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import { getGlobalCliOptions, writeError, writeResult } from "./common.js";

const checkOptionsSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string(),
  graderModel: z.string().optional(),
  apiKey: z.string().optional(),
  queries: z.string().optional(),
  numQueries: z.number().int().min(2),
  prompts: z.string().optional(),
  minF1: z.number().min(0).max(1),
  minAssertPassRate: z.number().min(0).max(1),
  saveResults: z.string().optional(),
  continueOnLintFail: z.boolean().optional(),
  verbose: z.boolean().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }
  return model;
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run lint + trigger + eval with threshold-based quality gates.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--provider <provider>", "LLM provider: anthropic|openai", "anthropic")
    .option("--model <model>", "Model for trigger/eval runs", DEFAULT_ANTHROPIC_MODEL)
    .option("--grader-model <model>", "Model used for grading (defaults to --model)")
    .option("--api-key <key>", "API key override")
    .option("--queries <path>", "Path to custom trigger queries JSON")
    .option("--num-queries <n>", "Number of auto-generated trigger queries", (value) => Number.parseInt(value, 10), 20)
    .option("--prompts <path>", "Path to eval prompts JSON")
    .option("--min-f1 <n>", "Minimum required trigger F1 score (0-1)", (value) => Number.parseFloat(value), 0.8)
    .option(
      "--min-assert-pass-rate <n>",
      "Minimum required eval assertion pass rate (0-1)",
      (value) => Number.parseFloat(value),
      0.9
    )
    .option("--save-results <path>", "Save combined check results to JSON")
    .option("--continue-on-lint-fail", "Continue trigger/eval stages even when lint has failures")
    .option("--verbose", "Show detailed trigger/eval output sections")
    .action(async (targetPath: string, commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const parsedOptions = checkOptionsSchema.safeParse(commandOptions);
      if (!parsedOptions.success) {
        writeError(new Error(parsedOptions.error.issues[0]?.message ?? "Invalid check options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      const options = parsedOptions.data;
      if (options.numQueries % 2 !== 0) {
        writeError(
          new Error("--num-queries must be an even number so the suite can split should/should-not trigger cases."),
          globalOptions.json
        );
        process.exitCode = 2;
        return;
      }

      const spinner = globalOptions.json || !process.stdout.isTTY ? null : ora("Preparing check run...").start();

      try {
        if (spinner) {
          spinner.text = "Initializing model provider...";
        }
        const provider = createProvider(options.provider as ProviderName, options.apiKey);

        let queries = undefined;
        if (options.queries) {
          if (spinner) {
            spinner.text = "Loading custom trigger queries...";
          }
          const loadedQueries = await readJsonFile<unknown>(options.queries);
          const parsedQueries = triggerQueryArraySchema.safeParse(loadedQueries);
          if (!parsedQueries.success) {
            throw new Error(
              `Invalid --queries JSON: ${parsedQueries.error.issues[0]?.message ?? "unknown format issue"}`
            );
          }
          queries = parsedQueries.data;
        }

        let prompts = undefined;
        if (options.prompts) {
          if (spinner) {
            spinner.text = "Loading eval prompts...";
          }
          const loadedPrompts = await readJsonFile<unknown>(options.prompts);
          const parsedPrompts = evalPromptArraySchema.safeParse(loadedPrompts);
          if (!parsedPrompts.success) {
            throw new Error(
              `Invalid --prompts JSON: ${parsedPrompts.error.issues[0]?.message ?? "unknown format issue"}`
            );
          }
          prompts = parsedPrompts.data;
        }

        const model = resolveModel(options.provider, options.model);
        const graderModel = options.graderModel ?? model;

        const result = await runCheck(targetPath, {
          provider,
          model,
          graderModel,
          queries,
          numQueries: options.numQueries,
          prompts,
          minF1: options.minF1,
          minAssertPassRate: options.minAssertPassRate,
          continueOnLintFail: Boolean(options.continueOnLintFail),
          verbose: Boolean(options.verbose),
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
        if (globalOptions.json) {
          writeResult(result, true);
        } else {
          writeResult(renderCheckReport(result, globalOptions.color, Boolean(options.verbose)), false);
        }

        process.exitCode = result.gates.overallPassed ? 0 : 1;
      } catch (error) {
        spinner?.stop();
        writeError(error, globalOptions.json);
        process.exitCode = 2;
      }
    });
}
