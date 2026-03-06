import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runEval } from "../core/eval-runner.js";
import { parseSkillStrict } from "../core/skill-parser.js";
import { createProvider } from "../providers/index.js";
import { renderEvalReport } from "../reporters/terminal.js";
import {
  getGlobalCliOptions,
  getResolvedConfig,
  loadConfiguredEvalPrompts,
  loadEvalPromptsJson,
  writeError,
  writeResult
} from "./common.js";
import { writeJsonFile } from "../utils/fs.js";

const evalCliSchema = z.object({
  prompts: z.string().optional(),
  graderModel: z.string().optional(),
  saveResults: z.string().optional(),
  verbose: z.boolean().optional(),
  apiKey: z.string().optional()
});

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

interface EvalCommandOptions {
  json: boolean;
  color: boolean;
  prompts?: string;
  model: string;
  graderModel?: string;
  provider: "anthropic" | "openai";
  saveResults?: string;
  verbose: boolean;
  apiKey?: string;
  numRuns: number;
}

function resolveModel(provider: "anthropic" | "openai", model: string): string {
  if (provider === "openai" && model === DEFAULT_ANTHROPIC_MODEL) {
    return DEFAULT_OPENAI_MODEL;
  }
  return model;
}

async function handleEvalCommand(targetPath: string, options: EvalCommandOptions, command: Command): Promise<void> {
  const spinner = options.json || !process.stdout.isTTY ? null : ora("Preparing evaluation...").start();

  try {
    if (spinner) {
      spinner.text = "Parsing skill...";
    }
    const skill = await parseSkillStrict(targetPath);

    if (spinner) {
      spinner.text = "Initializing model provider...";
    }
    const provider = createProvider(options.provider, options.apiKey);

    let prompts = undefined;
    if (options.prompts) {
      if (spinner) {
        spinner.text = "Loading test prompts...";
      }
      prompts = await loadEvalPromptsJson(options.prompts);
    } else {
      prompts = await loadConfiguredEvalPrompts(command);
    }

    if (spinner) {
      spinner.text = "Running eval prompts and grading responses...";
    }
    const model = resolveModel(options.provider, options.model);
    const graderModel = options.graderModel ?? model;
    const result = await runEval(skill, {
      provider,
      model,
      graderModel,
      numRuns: options.numRuns,
      prompts
    });

    if (options.saveResults) {
      await writeJsonFile(options.saveResults, result);
    }

    spinner?.stop();
    if (options.json) {
      writeResult(result, true);
    } else {
      writeResult(renderEvalReport(result, options.color, options.verbose), false);
    }
  } catch (error) {
    spinner?.stop();
    writeError(error, options.json);
    process.exitCode = 2;
  }
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run end-to-end skill execution and quality evaluation.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--prompts <path>", "Path to eval prompts JSON")
    .option("--model <model>", "Model to execute prompts")
    .option("--grader-model <model>", "Model used for grading (defaults to --model)")
    .option("--provider <provider>", "LLM provider: anthropic|openai")
    .option("--save-results <path>", "Save full evaluation results to JSON")
    .option("--api-key <key>", "API key override")
    .option("--verbose", "Show full model responses")
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);
      const parsedCli = evalCliSchema.safeParse(command.opts());
      if (!parsedCli.success) {
        writeError(new Error(parsedCli.error.issues[0]?.message ?? "Invalid eval options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      await handleEvalCommand(
        targetPath,
        {
          ...globalOptions,
          prompts: parsedCli.data.prompts,
          model: config.model,
          graderModel: parsedCli.data.graderModel,
          provider: config.provider,
          saveResults: parsedCli.data.saveResults,
          verbose: Boolean(parsedCli.data.verbose),
          apiKey: parsedCli.data.apiKey,
          numRuns: config.eval.numRuns
        },
        command
      );
    });
}
