import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";
import { z } from "zod";

export interface SkillFileContext {
  skillRoot: string;
  skillFile: string;
  raw: string;
  lineCount: number;
}

export interface FrontmatterParseResult {
  hasFrontmatter: boolean;
  rawFrontmatter: string | null;
  data: Record<string, unknown> | null;
  content: string;
  error: string | null;
}

const frontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    license: z.string().optional()
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof frontmatterSchema>;

export interface ParsedSkill {
  skillRoot: string;
  skillFile: string;
  raw: string;
  content: string;
  frontmatterRaw: string | null;
  frontmatter: SkillFrontmatter;
}

const FRONTMATTER_BLOCK_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export async function resolveSkillPath(inputPath: string): Promise<{ skillRoot: string; skillFile: string }> {
  const absoluteInput = path.resolve(inputPath);
  let stat;

  try {
    stat = await fs.stat(absoluteInput);
  } catch {
    throw new Error(`Path not found: ${inputPath}`);
  }

  if (stat.isDirectory()) {
    const skillFile = path.join(absoluteInput, "SKILL.md");
    try {
      const skillStat = await fs.stat(skillFile);
      if (!skillStat.isFile()) {
        throw new Error();
      }
    } catch {
      throw new Error(`No SKILL.md found in directory: ${inputPath}`);
    }

    return { skillRoot: absoluteInput, skillFile };
  }

  if (!stat.isFile()) {
    throw new Error(`Path is not a file or directory: ${inputPath}`);
  }

  if (path.basename(absoluteInput) !== "SKILL.md") {
    throw new Error(`Expected SKILL.md or a directory containing SKILL.md. Received: ${inputPath}`);
  }

  return { skillRoot: path.dirname(absoluteInput), skillFile: absoluteInput };
}

export async function loadSkillFile(inputPath: string): Promise<SkillFileContext> {
  const { skillRoot, skillFile } = await resolveSkillPath(inputPath);
  const raw = await fs.readFile(skillFile, "utf8");
  const lineCount = raw === "" ? 0 : raw.split(/\r?\n/).length;

  return { skillRoot, skillFile, raw, lineCount };
}

export function parseFrontmatter(rawSkill: string): FrontmatterParseResult {
  const blockMatch = rawSkill.match(FRONTMATTER_BLOCK_REGEX);
  const rawFrontmatter = blockMatch?.[1] ?? null;

  if (!rawFrontmatter) {
    return {
      hasFrontmatter: false,
      rawFrontmatter: null,
      data: null,
      content: rawSkill,
      error: null
    };
  }

  try {
    const parsedByYaml = yaml.load(rawFrontmatter);
    if (parsedByYaml === null || typeof parsedByYaml !== "object" || Array.isArray(parsedByYaml)) {
      return {
        hasFrontmatter: true,
        rawFrontmatter,
        data: null,
        content: rawSkill.replace(FRONTMATTER_BLOCK_REGEX, ""),
        error: "Frontmatter must parse into a YAML object."
      };
    }

    const parsedByMatter = matter(rawSkill);
    return {
      hasFrontmatter: true,
      rawFrontmatter,
      data: parsedByMatter.data as Record<string, unknown>,
      content: parsedByMatter.content,
      error: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown frontmatter parse error";
    return {
      hasFrontmatter: true,
      rawFrontmatter,
      data: null,
      content: rawSkill.replace(FRONTMATTER_BLOCK_REGEX, ""),
      error: message
    };
  }
}

export async function parseSkillStrict(inputPath: string): Promise<ParsedSkill> {
  const skillContext = await loadSkillFile(inputPath);
  const parsedFrontmatter = parseFrontmatter(skillContext.raw);

  if (!parsedFrontmatter.hasFrontmatter) {
    throw new Error("SKILL.md is missing YAML frontmatter.");
  }

  if (parsedFrontmatter.error) {
    throw new Error(`Invalid frontmatter: ${parsedFrontmatter.error}`);
  }

  const validation = frontmatterSchema.safeParse(parsedFrontmatter.data ?? {});
  if (!validation.success) {
    const issue = validation.error.issues[0];
    throw new Error(`Invalid frontmatter field '${issue.path.join(".")}': ${issue.message}`);
  }

  return {
    skillRoot: skillContext.skillRoot,
    skillFile: skillContext.skillFile,
    raw: skillContext.raw,
    content: parsedFrontmatter.content,
    frontmatterRaw: parsedFrontmatter.rawFrontmatter,
    frontmatter: validation.data
  };
}

const RELATIVE_LINK_PREFIXES = ["./", "../", "scripts/", "references/", "assets/"];

export function extractRelativeFileReferences(markdown: string): string[] {
  const references = new Set<string>();

  const markdownLinkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(markdownLinkRegex)) {
    const rawTarget = (match[1] ?? "").trim();
    const cleaned = cleanReferenceTarget(rawTarget);
    if (cleaned && isLikelyRelativePath(cleaned)) {
      references.add(cleaned);
    }
  }

  const inlineCodeRegex = /`([^`]+)`/g;
  for (const match of markdown.matchAll(inlineCodeRegex)) {
    const candidate = (match[1] ?? "").trim();
    if (isLikelyRelativePath(candidate)) {
      references.add(cleanReferenceTarget(candidate) as string);
    }
  }

  const barePathRegex = /\b(?:scripts|references|assets)\/[A-Za-z0-9._\-/]+/g;
  for (const match of markdown.matchAll(barePathRegex)) {
    const candidate = match[0];
    if (candidate) {
      references.add(cleanReferenceTarget(candidate) as string);
    }
  }

  return Array.from(references);
}

export function cleanReferenceTarget(target: string): string | null {
  if (!target) {
    return null;
  }

  let cleaned = target.trim();

  if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (cleaned === "" || cleaned.startsWith("#")) {
    return null;
  }

  if (/^(https?:|mailto:|tel:)/i.test(cleaned)) {
    return null;
  }

  const hashIndex = cleaned.indexOf("#");
  if (hashIndex >= 0) {
    cleaned = cleaned.slice(0, hashIndex).trim();
  }

  return cleaned || null;
}

export function isLikelyRelativePath(candidate: string): boolean {
  if (!candidate) {
    return false;
  }

  if (candidate.startsWith("/")) {
    return false;
  }

  if (/^[A-Za-z]:\\/.test(candidate)) {
    return false;
  }

  if (/^(https?:|mailto:|tel:)/i.test(candidate)) {
    return false;
  }

  if (RELATIVE_LINK_PREFIXES.some((prefix) => candidate.startsWith(prefix))) {
    return true;
  }

  return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(candidate);
}
