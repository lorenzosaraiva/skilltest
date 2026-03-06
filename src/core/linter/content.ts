import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

const VAGUE_PATTERNS = [
  /\bdo something appropriate\b/i,
  /\bhandle as needed\b/i,
  /\buse best judgment\b/i,
  /\bif possible\b/i,
  /\bwhen relevant\b/i,
  /\bdo what seems right\b/i
];

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "OpenAI key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: "Generic private key header", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

export function runContentChecks(context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const body = context.frontmatter.content;
  const bodyLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const description = typeof context.frontmatter.data?.description === "string" ? context.frontmatter.data.description : "";

  if (!/^#{1,6}\s+\S+/m.test(body)) {
    issues.push({
      id: "content.headers",
      checkId: "content:headers",
      title: "Section Headers",
      status: "warn",
      message: "No markdown headers found in SKILL.md body.",
      suggestion: "Add section headers to improve scannability and maintenance."
    });
  } else {
    issues.push({
      id: "content.headers",
      checkId: "content:headers",
      title: "Section Headers",
      status: "pass",
      message: "SKILL.md contains markdown section headers."
    });
  }

  const hasExamples = /example/i.test(body) || /```[\s\S]*?```/.test(body);
  if (!hasExamples) {
    issues.push({
      id: "content.examples",
      checkId: "content:examples",
      title: "Examples",
      status: "warn",
      message: "No examples detected in SKILL.md body.",
      suggestion: "Add at least one concrete example to guide usage."
    });
  } else {
    issues.push({
      id: "content.examples",
      checkId: "content:examples",
      title: "Examples",
      status: "pass",
      message: "Examples were detected in SKILL.md."
    });
  }

  const vagueMatches = VAGUE_PATTERNS.filter((pattern) => pattern.test(body));
  if (vagueMatches.length > 0) {
    issues.push({
      id: "content.vagueness",
      checkId: "content:vagueness",
      title: "Instruction Specificity",
      status: "warn",
      message: "Potentially vague instruction phrases detected.",
      suggestion: "Replace vague guidance with explicit decision rules or step-by-step instructions."
    });
  } else {
    issues.push({
      id: "content.vagueness",
      checkId: "content:vagueness",
      title: "Instruction Specificity",
      status: "pass",
      message: "No obvious vague placeholder phrasing found."
    });
  }

  if (context.frontmatter.rawFrontmatter && /[<>]/.test(context.frontmatter.rawFrontmatter)) {
    issues.push({
      id: "content.frontmatter-angle-brackets",
      checkId: "content:angle-brackets",
      title: "Frontmatter Angle Brackets",
      status: "warn",
      message: "Frontmatter contains angle bracket characters (< or >), which can be misinterpreted in some agents.",
      suggestion: "Remove XML-like tags from frontmatter values when possible."
    });
  } else {
    issues.push({
      id: "content.frontmatter-angle-brackets",
      checkId: "content:angle-brackets",
      title: "Frontmatter Angle Brackets",
      status: "pass",
      message: "No angle bracket tokens detected in frontmatter."
    });
  }

  const secretHits = new Set<string>();
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(context.skill.raw)) {
      secretHits.add(pattern.label);
    }
  }
  if (secretHits.size > 0) {
    issues.push({
      id: "content.secrets",
      checkId: "content:secrets",
      title: "Hardcoded Secrets",
      status: "fail",
      message: `Potential secrets detected (${Array.from(secretHits).join(", ")}).`,
      suggestion: "Remove secrets from skill files and use environment variables or secret managers."
    });
  } else {
    issues.push({
      id: "content.secrets",
      checkId: "content:secrets",
      title: "Hardcoded Secrets",
      status: "pass",
      message: "No obvious API keys or secrets patterns were detected."
    });
  }

  if (bodyLines.length < 10) {
    issues.push({
      id: "content.body-length",
      checkId: "content:body-length",
      title: "Body Completeness",
      status: "warn",
      message: `SKILL.md body has only ${bodyLines.length} non-empty lines.`,
      suggestion: "Add more detailed instructions; short bodies are often incomplete."
    });
  } else {
    issues.push({
      id: "content.body-length",
      checkId: "content:body-length",
      title: "Body Completeness",
      status: "pass",
      message: `SKILL.md body has ${bodyLines.length} non-empty lines.`
    });
  }

  if (description && description.length < 50) {
    issues.push({
      id: "content.description-length",
      checkId: "content:description-length",
      title: "Description Specificity",
      status: "warn",
      message: `Description length is ${description.length} characters, which may be too vague for reliable triggering.`,
      suggestion: "Expand description with concrete scope and activation conditions."
    });
  } else if (description) {
    issues.push({
      id: "content.description-length",
      checkId: "content:description-length",
      title: "Description Specificity",
      status: "pass",
      message: "Description length is sufficient for triggerability heuristics."
    });
  }

  return issues;
}
