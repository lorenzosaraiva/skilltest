import { Command } from "commander";
import { lintFails, runLinter } from "../core/linter/index.js";
import { renderLintReport } from "../reporters/terminal.js";
import { getGlobalCliOptions, getResolvedConfig, writeError, writeResult } from "./common.js";

interface LintCommandOptions {
  json: boolean;
  color: boolean;
  failOn: "error" | "warn";
  suppress: string[];
}

async function handleLintCommand(targetPath: string, options: LintCommandOptions): Promise<void> {
  try {
    const report = await runLinter(targetPath, { suppress: options.suppress });
    if (options.json) {
      writeResult(report, true);
    } else {
      writeResult(renderLintReport(report, options.color), false);
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
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);
      const config = getResolvedConfig(command);

      await handleLintCommand(targetPath, {
        ...globalOptions,
        failOn: config.lint.failOn,
        suppress: config.lint.suppress
      });
    });
}
