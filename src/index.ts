import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerLintCommand } from "./commands/lint.js";
import { registerTriggerCommand } from "./commands/trigger.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerCheckCommand } from "./commands/check.js";
import { setCommandExecutionContext } from "./commands/common.js";
import { extractCliConfigOverrides, resolveConfigContext } from "./utils/config.js";

function resolveVersion(): string {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const packageJsonPath = path.resolve(path.dirname(currentFilePath), "..", "package.json");
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function shouldRenderJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function renderTopLevelError(error: unknown, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`Error: ${message}\n`);
}

export async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("skilltest")
    .description("The testing framework for Agent Skills.")
    .version(resolveVersion())
    .option("--json", "Output results as JSON")
    .option("--no-color", "Disable colored output")
    .showHelpAfterError();

  program.hook("preAction", async (_program, actionCommand) => {
    const targetPath = typeof actionCommand.processedArgs[0] === "string" ? actionCommand.processedArgs[0] : undefined;
    const cliOverrides = extractCliConfigOverrides(actionCommand);
    const context = await resolveConfigContext(targetPath, cliOverrides);
    setCommandExecutionContext(actionCommand, context);
  });

  registerLintCommand(program);
  registerTriggerCommand(program);
  registerEvalCommand(program);
  registerCheckCommand(program);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    renderTopLevelError(error, shouldRenderJson(argv));
    process.exitCode = 2;
  }
}

run(process.argv).catch((error: unknown) => {
  renderTopLevelError(error, shouldRenderJson(process.argv));
  process.exitCode = 2;
});
