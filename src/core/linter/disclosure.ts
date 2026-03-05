import fs from "node:fs/promises";
import path from "node:path";
import {
  cleanReferenceTarget,
  extractRelativeFileReferences,
  isLikelyRelativePath
} from "../skill-parser.js";
import { pathExists, toPosixPath } from "../../utils/fs.js";
import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function detectNestedReferenceChain(skillRoot: string, rootContent: string): Promise<number> {
  const initialReferences = extractRelativeFileReferences(rootContent);
  let maxDepth = 0;

  for (const reference of initialReferences) {
    const firstLevelPath = path.resolve(skillRoot, reference);
    if (!(await pathExists(firstLevelPath))) {
      continue;
    }
    const firstLevelRaw = await fs.readFile(firstLevelPath, "utf8");
    const secondLevelRefs = extractRelativeFileReferences(firstLevelRaw);
    if (secondLevelRefs.length > 0) {
      maxDepth = Math.max(maxDepth, 1);
    }

    for (const secondLevelReference of secondLevelRefs) {
      const secondLevelPath = path.resolve(path.dirname(firstLevelPath), secondLevelReference);
      if (!(await pathExists(secondLevelPath))) {
        continue;
      }
      const secondLevelRaw = await fs.readFile(secondLevelPath, "utf8");
      const thirdLevelRefs = extractRelativeFileReferences(secondLevelRaw);
      if (thirdLevelRefs.length > 0) {
        maxDepth = Math.max(maxDepth, 2);
      }
    }
  }

  return maxDepth;
}

export async function runDisclosureChecks(context: LintContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const references = extractRelativeFileReferences(context.skill.raw);
  const referencesDir = path.join(context.skill.skillRoot, "references");

  if (context.skill.lineCount > 200 && !(await pathExists(referencesDir))) {
    issues.push({
      id: "disclosure.skill-split",
      title: "Progressive Disclosure",
      status: "warn",
      message: "SKILL.md exceeds 200 lines and no references/ directory is present.",
      suggestion: "Move detailed material into references/ files and keep SKILL.md focused."
    });
  } else {
    issues.push({
      id: "disclosure.skill-split",
      title: "Progressive Disclosure",
      status: "pass",
      message: "Top-level file length and references/ usage look reasonable."
    });
  }

  const nonRelativeOrEscaping: string[] = [];
  for (const rawReference of references) {
    const cleaned = cleanReferenceTarget(rawReference);
    if (!cleaned) {
      continue;
    }
    if (path.isAbsolute(cleaned) || /^[A-Za-z]:\\/.test(cleaned) || cleaned.startsWith("~")) {
      nonRelativeOrEscaping.push(cleaned);
      continue;
    }
    if (!isLikelyRelativePath(cleaned)) {
      nonRelativeOrEscaping.push(cleaned);
      continue;
    }
    const resolved = path.resolve(context.skill.skillRoot, cleaned);
    if (!isPathInsideRoot(context.skill.skillRoot, resolved)) {
      nonRelativeOrEscaping.push(cleaned);
    }
  }

  if (nonRelativeOrEscaping.length > 0) {
    issues.push({
      id: "disclosure.relative-path-root",
      title: "Reference Path Scope",
      status: "fail",
      message: `Found non-relative or out-of-root references: ${nonRelativeOrEscaping.join(", ")}`,
      suggestion: "Use relative paths that stay within the skill root directory."
    });
  } else {
    issues.push({
      id: "disclosure.relative-path-root",
      title: "Reference Path Scope",
      status: "pass",
      message: "All detected file references are relative and scoped to skill root."
    });
  }

  const chainDepth = await detectNestedReferenceChain(context.skill.skillRoot, context.skill.raw);
  if (chainDepth > 1) {
    issues.push({
      id: "disclosure.reference-depth",
      title: "Reference Chain Depth",
      status: "warn",
      message: "Deep reference chains detected (>1 level).",
      suggestion: "Avoid linking from references to more nested references where possible."
    });
  } else {
    issues.push({
      id: "disclosure.reference-depth",
      title: "Reference Chain Depth",
      status: "pass",
      message: "Reference depth is shallow and easy to navigate."
    });
  }

  const normalizedReferences = references.map((item) => toPosixPath(item));
  if (normalizedReferences.some((item) => item.includes("../"))) {
    issues.push({
      id: "disclosure.parent-traversal",
      title: "Parent Traversal",
      status: "warn",
      message: "References include parent-directory traversal (../).",
      suggestion: "Prefer references rooted within the skill directory for portability."
    });
  } else {
    issues.push({
      id: "disclosure.parent-traversal",
      title: "Parent Traversal",
      status: "pass",
      message: "No parent-directory traversal references detected."
    });
  }

  return issues;
}
