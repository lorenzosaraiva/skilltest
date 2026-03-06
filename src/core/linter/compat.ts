import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

export function runCompatibilityChecks(context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const frontmatter = context.frontmatter.data ?? {};
  const body = context.frontmatter.content;

  const hasAllowedTools = Object.prototype.hasOwnProperty.call(frontmatter, "allowed-tools");
  const mentionsClaudeOnly = /\bclaude code\b/i.test(body);
  const mentionsCodexOnly = /\bcodex\b/i.test(body) && !/\bopenai\b/i.test(body);

  if (hasAllowedTools) {
    issues.push({
      id: "compat.allowed-tools",
      checkId: "compat:frontmatter",
      title: "Platform-Specific Frontmatter",
      status: "warn",
      message: "Frontmatter includes allowed-tools, which is typically Claude-specific.",
      suggestion: "Document fallback behavior for platforms that ignore allowed-tools."
    });
  } else {
    issues.push({
      id: "compat.allowed-tools",
      checkId: "compat:frontmatter",
      title: "Platform-Specific Frontmatter",
      status: "pass",
      message: "No known provider-specific frontmatter keys detected."
    });
  }

  if (mentionsClaudeOnly || mentionsCodexOnly) {
    const platform = mentionsClaudeOnly ? "Claude" : "Codex";
    issues.push({
      id: "compat.provider-phrasing",
      checkId: "compat:provider-language",
      title: "Provider-Specific Language",
      status: "warn",
      message: `Skill body appears tuned to ${platform}-specific behavior.`,
      suggestion: "Add neutral instructions or an explicit compatibility note for other agents."
    });
  } else {
    issues.push({
      id: "compat.provider-phrasing",
      checkId: "compat:provider-language",
      title: "Provider-Specific Language",
      status: "pass",
      message: "Skill body appears provider-neutral."
    });
  }

  const likelyCompatibility = hasAllowedTools || mentionsClaudeOnly || mentionsCodexOnly
    ? "Likely compatible with some agents, but includes platform-specific assumptions."
    : "Likely broadly compatible across Anthropic, OpenAI/Codex-style, and other markdown skill runners.";

  issues.push({
    id: "compat.summary",
    checkId: "compat:summary",
    title: "Compatibility Hint",
    status: hasAllowedTools || mentionsClaudeOnly || mentionsCodexOnly ? "warn" : "pass",
    message: likelyCompatibility
  });

  return issues;
}
