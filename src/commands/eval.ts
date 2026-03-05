import ora from "ora";
import { Command } from "commander";
import { z } from "zod";
import { runEval, evalPromptArraySchema } from "../core/eval-runner.js";
import { parseSkillStrict } from "../core/skill-parser.js";
import { createProvider } from "../providers/index.js";
import { ProviderName } from "../providers/types.js";
import { renderEvalReport } from "../reporters/terminal.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import { getGlobalCliOptions, writeError, writeResult } from "./common.js";

const evalOptionsSchema = z.object({
  prompts: z.string().optional(),
  model: z.string(),
  graderModel: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]),
  saveResults: z.string().optional(),
  verbose: z.boolean().optional(),
  apiKey: z.string().optional()
});

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run end-to-end skill execution and quality evaluation.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--prompts <path>", "Path to eval prompts JSON")
    .option("--model <model>", "Model to execute prompts", "claude-sonnet-4-5-20250929")
    .option("--grader-model <model>", "Model used for grading (defaults to --model)")
    .option("--provider <provider>", "LLM provider: anthropic|openai", "anthropic")
    .option("--save-results <path>", "Save full evaluation results to JSON")
    .option("--api-key <key>", "API key override")
    .option("--verbose", "Show full model responses")
    .action(async (targetPath: string, commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const parsedOptions = evalOptionsSchema.safeParse(commandOptions);
      if (!parsedOptions.success) {
        writeError(new Error(parsedOptions.error.issues[0]?.message ?? "Invalid eval options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      const options = parsedOptions.data;
      const spinner = globalOptions.json || !process.stdout.isTTY ? null : ora("Preparing evaluation...").start();

      try {
        if (spinner) {
          spinner.text = "Parsing skill...";
        }
        const skill = await parseSkillStrict(targetPath);

        if (spinner) {
          spinner.text = "Initializing model provider...";
        }
        const provider = createProvider(options.provider as ProviderName, options.apiKey);

        let prompts = undefined;
        if (options.prompts) {
          if (spinner) {
            spinner.text = "Loading test prompts...";
          }
          const loaded = await readJsonFile<unknown>(options.prompts);
          const parsedPrompts = evalPromptArraySchema.safeParse(loaded);
          if (!parsedPrompts.success) {
            throw new Error(`Invalid --prompts JSON: ${parsedPrompts.error.issues[0]?.message ?? "unknown format issue"}`);
          }
          prompts = parsedPrompts.data;
        }

        if (spinner) {
          spinner.text = "Running eval prompts and grading responses...";
        }
        const result = await runEval(skill, {
          provider,
          model: options.model,
          graderModel: options.graderModel ?? options.model,
          prompts
        });

        if (options.saveResults) {
          await writeJsonFile(options.saveResults, result);
        }

        spinner?.stop();
        if (globalOptions.json) {
          writeResult(result, true);
        } else {
          writeResult(renderEvalReport(result, globalOptions.color, Boolean(options.verbose)), false);
        }
      } catch (error) {
        spinner?.stop();
        writeError(error, globalOptions.json);
        process.exitCode = 2;
      }
    });
}
