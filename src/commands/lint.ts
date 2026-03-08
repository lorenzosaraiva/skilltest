import fs from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { lintFails, runLinter } from "../core/linter/index.js";
import { renderLintHtml } from "../reporters/html.js";
import { renderLintReport } from "../reporters/terminal.js";
import { getGlobalCliOptions, getResolvedConfig, writeError, writeResult } from "./common.js";

const lintCliSchema = z.object({
  html: z.string().optional(),
  plugin: z.array(z.string().min(1)).optional()
});

interface LintCommandOptions {
  json: boolean;
  color: boolean;
  failOn: "error" | "warn";
  suppress: string[];
  plugins: string[];
  html?: string;
}

function collectPluginPaths(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function handleLintCommand(targetPath: string, options: LintCommandOptions): Promise<void> {
  try {
    const report = await runLinter(targetPath, { suppress: options.suppress, plugins: options.plugins });
    if (options.json) {
      writeResult(report, true);
    } else {
      writeResult(renderLintReport(report, options.color), false);
    }

    if (options.html) {
      await fs.writeFile(options.html, renderLintHtml(report), "utf8");
    }

    if (lintFails(report, options.failOn)) {
      process.exitCode = 1;
    }
  } catch (error) {
    writeError(error, options.json);
    process.exitCode = 2;
  }
}

export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Run static lint checks against a SKILL.md file or skill directory.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .option("--html <path>", "Write an HTML report to the given file path")
    .option("--plugin <path>", "Load a custom lint plugin file", collectPluginPaths, [])
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);
      const parsedCli = lintCliSchema.safeParse(command.opts());
      if (!parsedCli.success) {
        writeError(new Error(parsedCli.error.issues[0]?.message ?? "Invalid lint options."), globalOptions.json);
        process.exitCode = 2;
        return;
      }

      await handleLintCommand(targetPath, {
        ...globalOptions,
        failOn: config.lint.failOn,
        suppress: config.lint.suppress,
        plugins: config.lint.plugins,
        html: parsedCli.data.html
      });
    });
}
