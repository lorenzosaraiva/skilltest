import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerLintCommand } from "./commands/lint.js";
import { registerTriggerCommand } from "./commands/trigger.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerCheckCommand } from "./commands/check.js";

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

export async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("skilltest")
    .description("The testing framework for Agent Skills.")
    .version(resolveVersion())
    .option("--json", "Output results as JSON")
    .option("--no-color", "Disable colored output")
    .showHelpAfterError();

  registerLintCommand(program);
  registerTriggerCommand(program);
  registerEvalCommand(program);
  registerCheckCommand(program);

  await program.parseAsync(argv);
}

run(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 2;
});
