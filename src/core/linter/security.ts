import { LintContext } from "./context.js";
import { LintIssue } from "./types.js";

interface SecurityPattern {
  label: string;
  regex: RegExp;
}

const DANGEROUS_COMMAND_PATTERNS: SecurityPattern[] = [
  {
    label: "Destructive recursive delete",
    regex: /\b(?:sudo\s+)?rm\s+-rf\s+(?:\/|\*|~\/|\.\.\/)/i
  },
  {
    label: "Forceful recursive remove in PowerShell",
    regex: /\bRemove-Item\b[^\n]*\b-Recurse\b[^\n]*\b-Force\b/i
  },
  {
    label: "Remote script piped directly to shell",
    regex: /\b(?:curl|wget|Invoke-WebRequest)\b[^\n|]{0,220}\|\s*(?:bash|sh|zsh|pwsh|powershell|iex)\b/i
  }
];

const EXFILTRATION_PATTERNS: SecurityPattern[] = [
  {
    label: "Reading SSH private keys",
    regex: /\b(?:cat|type|get-content)\b[^\n]*\.ssh\/id_(?:rsa|ed25519)\b/i
  },
  {
    label: "Reading cloud credential files",
    regex: /\b(?:cat|type|get-content)\b[^\n]*(?:\.aws\/credentials|\.npmrc|\.netrc)\b/i
  },
  {
    label: "Explicit credential exfiltration",
    regex: /\b(?:send|upload|post|exfiltrat(?:e|ion))\b[^\n]{0,200}\b(?:api[_ -]?key|token|secret|credential|\.env|id_rsa)\b/i
  }
];

const PRIVILEGE_ESCALATION_PATTERNS: SecurityPattern[] = [
  {
    label: "Uses sudo/root escalation",
    regex: /\b(?:sudo|run as root|administrator privileges)\b/i
  },
  {
    label: "Asks to disable sandboxing or approvals",
    regex: /\b(?:disable sandbox|without approval|skip approval|require_escalated)\b/i
  },
  {
    label: "Inline expression execution",
    regex: /\b(?:Invoke-Expression|iex)\b/i
  }
];

const SHELL_ACTIVITY_PATTERNS: RegExp[] = [
  /```(?:bash|sh|zsh|pwsh|powershell|cmd)\b[\s\S]*?```/i,
  /\b(?:bash|sh|pwsh|powershell|cmd(?:\.exe)?)\b/i,
  /\b(?:npm|pnpm|yarn|pip|git|docker|kubectl)\s+[A-Za-z0-9-]/i
];

const SAFETY_GUARDRAIL_PATTERN =
  /\b(?:ask before|confirm|approval|dry[- ]run|sandbox|least privilege|redact|never expose|do not reveal)\b/i;

function collectMatches(content: string, patterns: SecurityPattern[]): string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      matches.push(pattern.label);
    }
  }
  return matches;
}

export function runSecurityChecks(context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const skillText = context.skill.raw;

  const dangerousCommandHits = collectMatches(skillText, DANGEROUS_COMMAND_PATTERNS);
  if (dangerousCommandHits.length > 0) {
    issues.push({
      id: "security.dangerous-command-patterns",
      title: "Dangerous Command Patterns",
      status: "fail",
      message: `Potentially dangerous command instruction patterns found: ${dangerousCommandHits.join(", ")}.`,
      suggestion: "Remove destructive/pipe-exec command examples or wrap them with explicit safety constraints."
    });
  } else {
    issues.push({
      id: "security.dangerous-command-patterns",
      title: "Dangerous Command Patterns",
      status: "pass",
      message: "No high-risk destructive or direct pipe-to-shell patterns detected."
    });
  }

  const exfiltrationHits = collectMatches(skillText, EXFILTRATION_PATTERNS);
  if (exfiltrationHits.length > 0) {
    issues.push({
      id: "security.exfiltration-patterns",
      title: "Sensitive Data Exfiltration",
      status: "fail",
      message: `Possible sensitive data exfiltration patterns found: ${exfiltrationHits.join(", ")}.`,
      suggestion: "Remove instructions that access or transmit secrets/credential files."
    });
  } else {
    issues.push({
      id: "security.exfiltration-patterns",
      title: "Sensitive Data Exfiltration",
      status: "pass",
      message: "No obvious credential access/exfiltration instructions detected."
    });
  }

  const escalationHits = collectMatches(skillText, PRIVILEGE_ESCALATION_PATTERNS);
  if (escalationHits.length > 0) {
    issues.push({
      id: "security.privilege-escalation",
      title: "Privilege Escalation Language",
      status: "warn",
      message: `Potentially risky privilege/execution language detected: ${escalationHits.join(", ")}.`,
      suggestion: "Prefer least-privilege execution and explicit approval steps for elevated commands."
    });
  } else {
    issues.push({
      id: "security.privilege-escalation",
      title: "Privilege Escalation Language",
      status: "pass",
      message: "No obvious privilege-escalation language detected."
    });
  }

  const hasShellActivity = SHELL_ACTIVITY_PATTERNS.some((pattern) => pattern.test(skillText));
  if (hasShellActivity && !SAFETY_GUARDRAIL_PATTERN.test(skillText)) {
    issues.push({
      id: "security.safety-guardrails",
      title: "Execution Safety Guardrails",
      status: "warn",
      message: "Shell/tool execution is present, but no explicit safety guardrails were detected.",
      suggestion: "Add guidance such as approval requirements, dry-run mode, scope checks, and redaction rules."
    });
  } else {
    issues.push({
      id: "security.safety-guardrails",
      title: "Execution Safety Guardrails",
      status: "pass",
      message: hasShellActivity
        ? "Shell/tool execution instructions include at least one safety guardrail."
        : "No shell/tool execution instructions detected."
    });
  }

  return issues;
}
