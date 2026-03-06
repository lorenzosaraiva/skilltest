import fs from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { EvalPrompt, evalPromptArraySchema } from "../core/eval-runner.js";
import { TriggerQuery, triggerQueryArraySchema } from "../core/trigger-tester.js";
import { renderJson } from "../reporters/json.js";
import { ResolvedConfigContext } from "../utils/config.js";
import { readJsonFile } from "../utils/fs.js";

const executionContextByCommand = new WeakMap<Command, ResolvedConfigContext>();

const singleEvalPromptSchema = z.object({
  prompt: z.string().min(1),
  assertions: z.array(z.string().min(1)).optional()
});

const promptStringArraySchema = z.array(z.string().min(1));
const assertionsObjectSchema = z.object({
  assertions: z.array(z.string().min(1))
});

export interface GlobalCliOptions {
  json: boolean;
  color: boolean;
}

function parseJsonIfPossible(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function normalizeEvalPrompts(value: unknown, sourceLabel: string): EvalPrompt[] {
  const promptArray = evalPromptArraySchema.safeParse(value);
  if (promptArray.success) {
    return promptArray.data;
  }

  const singlePrompt = singleEvalPromptSchema.safeParse(value);
  if (singlePrompt.success) {
    return [singlePrompt.data];
  }

  const promptStrings = promptStringArraySchema.safeParse(value);
  if (promptStrings.success) {
    return promptStrings.data.map((prompt) => ({ prompt }));
  }

  if (typeof value === "string" && value.trim() !== "") {
    return [{ prompt: value.trim() }];
  }

  throw new Error(
    `Invalid eval prompt source at ${sourceLabel}. Expected plain text, a JSON prompt object, or a JSON array of prompts.`
  );
}

function parseAssertionsFromText(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
    .filter((line) => line.length > 0);
}

function normalizeAssertions(value: unknown, sourceLabel: string): string[] {
  const assertionArray = z.array(z.string().min(1)).safeParse(value);
  if (assertionArray.success) {
    return assertionArray.data;
  }

  const assertionObject = assertionsObjectSchema.safeParse(value);
  if (assertionObject.success) {
    return assertionObject.data.assertions;
  }

  if (typeof value === "string") {
    const assertions = parseAssertionsFromText(value);
    if (assertions.length > 0) {
      return assertions;
    }
  }

  throw new Error(
    `Invalid eval assertions source at ${sourceLabel}. Expected JSON string[], { assertions: string[] }, or newline-delimited text.`
  );
}

export function setCommandExecutionContext(command: Command, context: ResolvedConfigContext): void {
  executionContextByCommand.set(command, context);
}

export function getCommandExecutionContext(command: Command): ResolvedConfigContext {
  const context = executionContextByCommand.get(command);
  if (!context) {
    throw new Error(`Missing resolved config for command '${command.name()}'.`);
  }
  return context;
}

export function getResolvedConfig(command: Command): ResolvedConfigContext["config"] {
  return getCommandExecutionContext(command).config;
}

export function getGlobalCliOptions(command: Command): GlobalCliOptions {
  const options = command.optsWithGlobals<{ json?: boolean; color?: boolean }>();
  const context = executionContextByCommand.get(command);

  return {
    json: context?.config.json ?? Boolean(options.json),
    color: options.color !== false
  };
}

export async function loadTriggerQueriesFile(filePath: string): Promise<TriggerQuery[]> {
  const loaded = await readJsonFile<unknown>(filePath);
  const parsed = triggerQueryArraySchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid --queries JSON: ${parsed.error.issues[0]?.message ?? "unknown format issue"}`);
  }
  return parsed.data;
}

export async function loadEvalPromptsJson(filePath: string): Promise<EvalPrompt[]> {
  const loaded = await readJsonFile<unknown>(filePath);
  const parsed = evalPromptArraySchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid --prompts JSON: ${parsed.error.issues[0]?.message ?? "unknown format issue"}`);
  }
  return parsed.data;
}

export async function loadConfiguredEvalPrompts(command: Command): Promise<EvalPrompt[] | undefined> {
  const context = getCommandExecutionContext(command);
  const promptFile = context.config.eval.promptFile;
  const assertionsFile = context.config.eval.assertionsFile;

  if (!promptFile && !assertionsFile) {
    return undefined;
  }

  if (!promptFile && assertionsFile) {
    throw new Error("Config field eval.assertionsFile requires eval.promptFile.");
  }

  const promptRaw = await fs.readFile(promptFile as string, "utf8");
  let prompts = normalizeEvalPrompts(parseJsonIfPossible(promptRaw), promptFile as string);

  if (assertionsFile) {
    const assertionsRaw = await fs.readFile(assertionsFile, "utf8");
    const assertions = normalizeAssertions(parseJsonIfPossible(assertionsRaw), assertionsFile);
    prompts = prompts.map((prompt) => ({
      prompt: prompt.prompt,
      assertions: [...assertions]
    }));
  }

  const numRunsWasExplicit = context.configFile?.eval?.numRuns !== undefined;
  if (numRunsWasExplicit && prompts.length === 1 && context.config.eval.numRuns > 1) {
    const promptTemplate = prompts[0];
    prompts = Array.from({ length: context.config.eval.numRuns }, () => ({
      prompt: promptTemplate.prompt,
      assertions: promptTemplate.assertions ? [...promptTemplate.assertions] : undefined
    }));
  }

  return prompts;
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
