import { Command } from "commander";
import { runLinter } from "../core/linter/index.js";
import { renderLintReport } from "../reporters/terminal.js";
import { getGlobalCliOptions, writeError, writeResult } from "./common.js";

export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Run static lint checks against a SKILL.md file or skill directory.")
    .argument("<path-to-skill>", "Path to SKILL.md or skill directory")
    .action(async (targetPath: string, _commandOptions: unknown, command: Command) => {
      const globalOptions = getGlobalCliOptions(command);

      try {
        const report = await runLinter(targetPath);
        if (globalOptions.json) {
          writeResult(report, true);
        } else {
          writeResult(renderLintReport(report, globalOptions.color), false);
        }

        if (report.summary.failures > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        writeError(error, globalOptions.json);
        process.exitCode = 2;
      }
    });
}
