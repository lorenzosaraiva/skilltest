import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLinter } from "./index.js";
import { loadPlugin } from "./plugin.js";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skilltest-plugin-"));
  tempDirectories.push(directory);
  return directory;
}

async function createPluginFile(source: string): Promise<string> {
  const directory = await createTempDirectory();
  const filePath = path.join(directory, "plugin.mjs");
  await fs.writeFile(filePath, source, "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("loadPlugin", () => {
  it("loads a valid plugin from the default export", async () => {
    const pluginPath = await createPluginFile(`
      export default {
        rules: [
          {
            checkId: "custom:no-todo",
            title: "No TODO comments",
            check() {
              return [];
            }
          }
        ]
      };
    `);

    const plugin = await loadPlugin(pluginPath);

    expect(plugin.rules).toHaveLength(1);
    expect(plugin.rules[0]?.checkId).toBe("custom:no-todo");
    expect(plugin.rules[0]?.title).toBe("No TODO comments");
    expect(typeof plugin.rules[0]?.check).toBe("function");
  });

  it("falls back to the named plugin export", async () => {
    const pluginPath = await createPluginFile(`
      export const plugin = {
        rules: [
          {
            checkId: "custom:named-export",
            title: "Named export rule",
            check() {
              return [];
            }
          }
        ]
      };
    `);

    const plugin = await loadPlugin(pluginPath);

    expect(plugin.rules[0]?.checkId).toBe("custom:named-export");
  });

  it("throws a descriptive error when the export shape is invalid", async () => {
    const pluginPath = await createPluginFile("export default {};");

    await expect(loadPlugin(pluginPath)).rejects.toThrow(/Invalid lint plugin at .*rules array/i);
  });

  it("prefixes rule checkIds that do not include a namespace", async () => {
    const pluginPath = await createPluginFile(`
      export default {
        rules: [
          {
            checkId: "no-foo",
            title: "No foo",
            check() {
              return [];
            }
          }
        ]
      };
    `);

    const plugin = await loadPlugin(pluginPath);

    expect(plugin.rules[0]?.checkId).toBe("plugin:no-foo");
  });
});

describe("plugin execution via runLinter", () => {
  it("adds plugin issues to the lint report", async () => {
    const pluginPath = await createPluginFile(`
      export default {
        rules: [
          {
            checkId: "custom:warn-issue",
            title: "Custom warning",
            check() {
              return [
                {
                  id: "custom.warn-issue",
                  checkId: "custom:warn-issue",
                  title: "Custom warning",
                  status: "warn",
                  message: "Plugin warning emitted."
                }
              ];
            }
          }
        ]
      };
    `);

    const report = await runLinter(path.resolve(process.cwd(), "test-fixtures/sample-skill"), { plugins: [pluginPath] });

    expect(report.issues.some((issue) => issue.id === "custom.warn-issue" && issue.checkId === "custom:warn-issue")).toBe(true);
  });

  it("emits a plugin:load-error failure when a rule throws and continues running remaining rules", async () => {
    const pluginPath = await createPluginFile(`
      export default {
        rules: [
          {
            checkId: "custom:broken-rule",
            title: "Broken rule",
            check() {
              throw new Error("boom");
            }
          },
          {
            checkId: "custom:still-runs",
            title: "Still runs",
            check() {
              return [
                {
                  id: "custom.still-runs",
                  checkId: "custom:still-runs",
                  title: "Still runs",
                  status: "pass",
                  message: "Second rule completed."
                }
              ];
            }
          }
        ]
      };
    `);

    const report = await runLinter(path.resolve(process.cwd(), "test-fixtures/sample-skill"), { plugins: [pluginPath] });
    const loadError = report.issues.find((issue) => issue.checkId === "plugin:load-error");

    expect(loadError?.status).toBe("fail");
    expect(loadError?.message).toContain("custom:broken-rule");
    expect(loadError?.message).toContain("boom");
    expect(report.issues.some((issue) => issue.id === "custom.still-runs" && issue.status === "pass")).toBe(true);
  });

  it("filters suppressed plugin rules from the report", async () => {
    const pluginPath = await createPluginFile(`
      export default {
        rules: [
          {
            checkId: "custom:suppress-me",
            title: "Suppress me",
            check() {
              return [
                {
                  id: "custom.suppress-me",
                  checkId: "custom:suppress-me",
                  title: "Suppress me",
                  status: "warn",
                  message: "This issue should be suppressed."
                }
              ];
            }
          }
        ]
      };
    `);

    const report = await runLinter(path.resolve(process.cwd(), "test-fixtures/sample-skill"), {
      plugins: [pluginPath],
      suppress: ["custom:suppress-me"]
    });

    expect(report.issues.some((issue) => issue.id === "custom.suppress-me")).toBe(false);
  });

  it("normalizes returned issue checkIds to the prefixed rule checkId", async () => {
    const pluginPath = await createPluginFile(`
      export default {
        rules: [
          {
            checkId: "no-foo",
            title: "No foo",
            check() {
              return [
                {
                  id: "custom.no-foo",
                  checkId: "no-foo",
                  title: "No foo",
                  status: "warn",
                  message: "Foo was found."
                }
              ];
            }
          }
        ]
      };
    `);

    const report = await runLinter(path.resolve(process.cwd(), "test-fixtures/sample-skill"), { plugins: [pluginPath] });
    const issue = report.issues.find((item) => item.id === "custom.no-foo");

    expect(issue?.checkId).toBe("plugin:no-foo");
  });
});
