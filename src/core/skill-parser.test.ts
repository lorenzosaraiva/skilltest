import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFrontmatter, parseSkillStrict } from "./skill-parser.js";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skilltest-parser-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("skill-parser", () => {
  it("parses valid frontmatter correctly", async () => {
    const parsed = await parseSkillStrict(path.resolve(process.cwd(), "test-fixtures/sample-skill"));

    expect(parsed.frontmatter.name).toBe("sample-skill");
    expect(parsed.frontmatter.description).toContain("Generates a concise test quality report");
    expect(parsed.content).toContain("# Sample Skill");
  });

  it("throws on a directory without SKILL.md", async () => {
    const directory = await createTempDirectory();

    await expect(parseSkillStrict(directory)).rejects.toThrow(/No SKILL\.md found/i);
  });

  it("handles malformed YAML gracefully", () => {
    const parsed = parseFrontmatter("---\nname: [oops\n---\n# Broken");

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.error).toBeTruthy();
    expect(parsed.data).toBeNull();
  });
});
