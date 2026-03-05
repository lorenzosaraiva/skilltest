import fs from "node:fs/promises";
import path from "node:path";
import { extractRelativeFileReferences } from "../skill-parser.js";
import { listFilesRecursive, pathExists, toPosixPath } from "../../utils/fs.js";
import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

function hasTableOfContents(content: string): boolean {
  if (/^#{1,6}\s+table of contents\b/im.test(content)) {
    return true;
  }
  return /^\s*[-*]\s+\[[^\]]+\]\(#[^)]+\)/im.test(content);
}

function classifyReferencePath(relativePath: string): "scripts" | "references" | "assets" | "other" {
  const normalized = toPosixPath(relativePath).replace(/^\.\//, "");
  if (normalized.startsWith("scripts/")) {
    return "scripts";
  }
  if (normalized.startsWith("references/")) {
    return "references";
  }
  if (normalized.startsWith("assets/")) {
    return "assets";
  }
  return "other";
}

export async function runStructureChecks(context: LintContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const references = extractRelativeFileReferences(context.skill.raw);

  if (context.skill.lineCount > 500) {
    issues.push({
      id: "structure.skill-size",
      title: "SKILL.md Size",
      status: "warn",
      message: `SKILL.md is ${context.skill.lineCount} lines (recommended max is 500).`,
      suggestion: "Split detailed guidance into references/ files."
    });
  } else {
    issues.push({
      id: "structure.skill-size",
      title: "SKILL.md Size",
      status: "pass",
      message: `SKILL.md length is ${context.skill.lineCount} lines.`
    });
  }

  const referencesDir = path.join(context.skill.skillRoot, "references");
  if (await pathExists(referencesDir)) {
    const files = await listFilesRecursive(referencesDir);
    let oversizedWithoutToc = 0;
    for (const file of files) {
      const raw = await fs.readFile(file, "utf8");
      const lineCount = raw === "" ? 0 : raw.split(/\r?\n/).length;
      if (lineCount > 300 && !hasTableOfContents(raw)) {
        oversizedWithoutToc += 1;
        issues.push({
          id: `structure.references.toc.${toPosixPath(path.relative(context.skill.skillRoot, file))}`,
          title: "Reference File Navigation",
          status: "warn",
          message: `${toPosixPath(path.relative(context.skill.skillRoot, file))} is ${lineCount} lines and has no table of contents.`,
          suggestion: "Add a table of contents for long reference files."
        });
      }
    }

    if (oversizedWithoutToc === 0) {
      issues.push({
        id: "structure.references.toc",
        title: "Reference File Navigation",
        status: "pass",
        message: "No oversized reference files missing a table of contents."
      });
    }
  } else {
    issues.push({
      id: "structure.references.toc",
      title: "Reference File Navigation",
      status: "pass",
      message: "No references/ directory found, so no long reference files to validate."
    });
  }

  const missingByType: Record<string, string[]> = {
    scripts: [],
    references: [],
    assets: [],
    other: []
  };

  for (const reference of references) {
    const resolved = path.resolve(context.skill.skillRoot, reference);
    if (!(await pathExists(resolved))) {
      const kind = classifyReferencePath(reference);
      missingByType[kind].push(reference);
    }
  }

  const categories: Array<{ key: "scripts" | "references" | "assets"; title: string }> = [
    { key: "scripts", title: "Script References" },
    { key: "references", title: "Reference File Links" },
    { key: "assets", title: "Asset References" }
  ];

  for (const category of categories) {
    const missing = missingByType[category.key];
    if (missing.length > 0) {
      issues.push({
        id: `structure.${category.key}.exists`,
        title: category.title,
        status: "fail",
        message: `Missing referenced ${category.key} file(s): ${missing.join(", ")}`,
        suggestion: "Create the files or fix the paths in SKILL.md."
      });
    } else {
      issues.push({
        id: `structure.${category.key}.exists`,
        title: category.title,
        status: "pass",
        message: `All referenced ${category.key} files exist.`
      });
    }
  }

  const missingGeneric = missingByType.other;
  if (missingGeneric.length > 0) {
    issues.push({
      id: "structure.relative-links.broken",
      title: "Relative Links",
      status: "fail",
      message: `Broken relative path reference(s): ${missingGeneric.join(", ")}`,
      suggestion: "Fix or remove broken file links."
    });
  } else {
    issues.push({
      id: "structure.relative-links.broken",
      title: "Relative Links",
      status: "pass",
      message: "No broken generic relative file references were found."
    });
  }

  return issues;
}
