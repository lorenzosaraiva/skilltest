import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

export interface LintRule {
  checkId: string;
  title: string;
  check: (context: LintContext) => LintIssue[] | Promise<LintIssue[]>;
}

export interface LintPlugin {
  rules: LintRule[];
}

function normalizeRuleCheckId(checkId: string): string {
  return checkId.includes(":") ? checkId : `plugin:${checkId}`;
}

function buildPluginValidationError(filePath: string, message: string): Error {
  return new Error(`Invalid lint plugin at ${filePath}: ${message}`);
}

function validatePluginCandidate(candidate: unknown, filePath: string, exportName: string): LintPlugin {
  if (!candidate || typeof candidate !== "object" || !("rules" in candidate)) {
    throw buildPluginValidationError(filePath, `${exportName} export must be an object with a rules array.`);
  }

  const rules = (candidate as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    throw buildPluginValidationError(filePath, `${exportName} export must include a rules array.`);
  }

  return {
    rules: rules.map((rule, index) => {
      if (!rule || typeof rule !== "object") {
        throw buildPluginValidationError(filePath, `rule at index ${index} must be an object.`);
      }

      const checkId = (rule as { checkId?: unknown }).checkId;
      if (typeof checkId !== "string" || checkId.trim() === "") {
        throw buildPluginValidationError(filePath, `rule at index ${index} must have a non-empty string checkId.`);
      }

      const title = (rule as { title?: unknown }).title;
      if (typeof title !== "string" || title.trim() === "") {
        throw buildPluginValidationError(filePath, `rule at index ${index} must have a non-empty string title.`);
      }

      const check = (rule as { check?: unknown }).check;
      if (typeof check !== "function") {
        throw buildPluginValidationError(filePath, `rule '${checkId}' must have a check function.`);
      }

      return {
        checkId: normalizeRuleCheckId(checkId),
        title,
        check: check as LintRule["check"]
      };
    })
  };
}

export async function loadPlugin(filePath: string): Promise<LintPlugin> {
  const absolutePath = path.resolve(filePath);

  try {
    await fs.access(absolutePath);
  } catch {
    throw new Error(`Failed to load lint plugin at ${absolutePath}: file does not exist.`);
  }

  let loadedModule: Record<string, unknown>;
  try {
    loadedModule = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load lint plugin at ${absolutePath}: ${message}`);
  }

  const validationErrors: string[] = [];
  for (const [exportName, candidate] of [
    ["default", loadedModule.default],
    ["plugin", loadedModule.plugin]
  ] as const) {
    if (candidate === undefined) {
      continue;
    }

    try {
      return validatePluginCandidate(candidate, absolutePath, exportName);
    } catch (error) {
      validationErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join(" "));
  }

  throw buildPluginValidationError(
    absolutePath,
    "expected a default export or named export 'plugin' containing a rules array."
  );
}

function buildRuleExecutionError(rule: LintRule, error: unknown): LintIssue {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: `plugin.load-error.${rule.checkId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`,
    checkId: "plugin:load-error",
    title: "Plugin Rule Error",
    status: "fail",
    message: `Plugin rule '${rule.checkId}' failed: ${message}`
  };
}

export async function runPluginRules(plugin: LintPlugin, context: LintContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const rule of plugin.rules) {
    try {
      const result = await rule.check(context);
      if (!Array.isArray(result)) {
        throw new Error("check function must return an array of lint issues.");
      }

      issues.push(
        ...result.map((issue) => ({
          ...issue,
          checkId: rule.checkId
        }))
      );
    } catch (error) {
      issues.push(buildRuleExecutionError(rule, error));
    }
  }

  return issues;
}
