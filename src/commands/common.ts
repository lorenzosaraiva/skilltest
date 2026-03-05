import { Command } from "commander";
import { renderJson } from "../reporters/json.js";

export interface GlobalCliOptions {
  json: boolean;
  color: boolean;
}

export function getGlobalCliOptions(command: Command): GlobalCliOptions {
  const options = command.optsWithGlobals<{ json?: boolean; color?: boolean }>();
  return {
    json: Boolean(options.json),
    color: options.color !== false
  };
}

export function writeResult(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${renderJson(value)}\n`);
    return;
  }
  process.stdout.write(`${String(value)}\n`);
}

export function writeError(error: unknown, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (asJson) {
    process.stdout.write(`${renderJson({ error: message })}\n`);
    return;
  }
  process.stderr.write(`Error: ${message}\n`);
}
