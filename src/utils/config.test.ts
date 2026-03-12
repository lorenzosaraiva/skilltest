import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SKILLTEST_CONFIG,
  extractCliConfigOverrides,
  mergeConfigLayers,
  resolveConfigContext
} from "./config.js";

const tempDirectories: string[] = [];
const originalCwd = process.cwd();

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skilltest-config-"));
  tempDirectories.push(directory);
  return directory;
}

function createTriggerCommand(argv: string[]): Command {
  const command = new Command("trigger");
  command.option("--json");
  command.option("--provider <provider>");
  command.option("--model <model>");
  command.option("--compare <path...>");
  command.option("--num-queries <n>", "Number of generated queries", (value: string) => Number.parseInt(value, 10));
  command.option("--concurrency <n>", "Maximum concurrency", (value: string) => Number.parseInt(value, 10));
  command.parse(argv, { from: "user" });
  return command;
}

function createLintCommand(argv: string[]): Command {
  const command = new Command("lint");
  command.option("--plugin <path>", "Load a custom lint plugin file", (value: string, previous: string[] = []) => [
    ...previous,
    value
  ], []);
  command.parse(argv, { from: "user" });
  return command;
}

function createImproveCommand(argv: string[]): Command {
  const command = new Command("improve");
  command.option("--provider <provider>");
  command.option("--model <model>");
  command.option("--compare <path...>");
  command.option("--num-queries <n>", "Number of generated queries", (value: string) => Number.parseInt(value, 10));
  command.option("--concurrency <n>", "Maximum concurrency", (value: string) => Number.parseInt(value, 10));
  command.option("--plugin <path>", "Load a custom lint plugin file", (value: string, previous: string[] = []) => [
    ...previous,
    value
  ], []);
  command.option("--min-f1 <n>", "Minimum F1", (value: string) => Number.parseFloat(value));
  command.option("--min-assert-pass-rate <n>", "Minimum assertion pass rate", (value: string) => Number.parseFloat(value));
  command.parse(argv, { from: "user" });
  return command;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("config utilities", () => {
  it("loads .skilltestrc JSON correctly", async () => {
    const skillRoot = await createTempDirectory();

    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: temp-skill\ndescription: Analyze repositories when a user asks for validation.\nlicense: MIT\n---\n# Body\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(skillRoot, ".skilltestrc"),
      JSON.stringify(
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          concurrency: 2,
          lint: {
            plugins: ["./plugins/org-rules.mjs"]
          },
          trigger: {
            numQueries: 12,
            threshold: 0.75,
            seed: 42,
            compare: ["../similar-skill"]
          },
          eval: {
            maxToolIterations: 7
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const context = await resolveConfigContext(skillRoot, {});

    expect(context.sourcePath).toBe(path.join(skillRoot, ".skilltestrc"));
    expect(context.config.provider).toBe("openai");
    expect(context.config.model).toBe("gpt-4.1-mini");
    expect(context.config.concurrency).toBe(2);
    expect(context.config.lint.plugins).toEqual([path.join(skillRoot, "plugins", "org-rules.mjs")]);
    expect(context.config.trigger.numQueries).toBe(12);
    expect(context.config.trigger.seed).toBe(42);
    expect(context.config.trigger.compare).toEqual([path.resolve(skillRoot, "..", "similar-skill")]);
    expect(context.config.eval.maxToolIterations).toBe(7);
  });

  it("lets CLI flags override config values", () => {
    const overrides = extractCliConfigOverrides(
      createTriggerCommand([
        "--provider",
        "openai",
        "--model",
        "gpt-4.1-mini",
        "--compare",
        "./sibling-a",
        "./sibling-b",
        "--num-queries",
        "14",
        "--json"
      ])
    );
    const merged = mergeConfigLayers(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        json: false,
        trigger: {
          numQueries: 20,
          compare: ["./config-sibling"]
        }
      },
      overrides,
      path.resolve(process.cwd(), "trigger-base")
    );

    expect(merged.provider).toBe("openai");
    expect(merged.model).toBe("gpt-4.1-mini");
    expect(merged.json).toBe(true);
    expect(merged.trigger.numQueries).toBe(14);
    expect(merged.trigger.compare).toEqual([
      path.resolve(process.cwd(), "trigger-base", "sibling-a"),
      path.resolve(process.cwd(), "trigger-base", "sibling-b")
    ]);
  });

  it("replaces config plugin paths with CLI plugin flags", () => {
    const overrides = extractCliConfigOverrides(createLintCommand(["--plugin", "./cli-rule.mjs", "--plugin", "./other-rule.mjs"]));
    const merged = mergeConfigLayers(
      {
        lint: {
          plugins: ["./config-rule.mjs"]
        }
      },
      overrides,
      path.resolve(process.cwd(), "fixtures")
    );

    expect(merged.lint.plugins).toEqual([
      path.resolve(process.cwd(), "fixtures", "cli-rule.mjs"),
      path.resolve(process.cwd(), "fixtures", "other-rule.mjs")
    ]);
  });

  it("supports improve command overrides for thresholds, plugins, compare paths, and concurrency", () => {
    const overrides = extractCliConfigOverrides(
      createImproveCommand([
        "--provider",
        "openai",
        "--model",
        "gpt-4.1-mini",
        "--compare",
        "./peer-skill",
        "--num-queries",
        "16",
        "--concurrency",
        "2",
        "--plugin",
        "./org-rule.mjs",
        "--min-f1",
        "0.9",
        "--min-assert-pass-rate",
        "0.95"
      ])
    );

    const merged = mergeConfigLayers(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        concurrency: 5,
        lint: {
          plugins: ["./config-rule.mjs"]
        },
        trigger: {
          numQueries: 20,
          threshold: 0.8,
          compare: ["./config-peer"]
        },
        eval: {
          threshold: 0.9
        }
      },
      overrides,
      path.resolve(process.cwd(), "fixtures")
    );

    expect(merged.provider).toBe("openai");
    expect(merged.model).toBe("gpt-4.1-mini");
    expect(merged.concurrency).toBe(2);
    expect(merged.trigger.numQueries).toBe(16);
    expect(merged.trigger.threshold).toBe(0.9);
    expect(merged.eval.threshold).toBe(0.95);
    expect(merged.trigger.compare).toEqual([path.resolve(process.cwd(), "fixtures", "peer-skill")]);
    expect(merged.lint.plugins).toEqual([path.resolve(process.cwd(), "fixtures", "org-rule.mjs")]);
  });

  it("falls back to defaults when no config file exists", async () => {
    const directory = await createTempDirectory();
    process.chdir(directory);

    const context = await resolveConfigContext(undefined, {});

    expect(context.sourcePath).toBeNull();
    expect(context.config).toMatchObject(DEFAULT_SKILLTEST_CONFIG);
    expect(context.config.eval.maxToolIterations).toBe(10);
  });
});
