import { LintContext } from "./context.js";
import { parseZones, Zone, ZoneType } from "./markdown-zones.js";
import { LintIssue, LintSkippedPattern } from "./types.js";

interface SecurityPattern {
  label: string;
  regex: RegExp;
}

interface PatternOccurrence extends LintSkippedPattern {}

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

function buildOccurrence(zone: Zone, pattern: SecurityPattern): PatternOccurrence {
  return {
    label: pattern.label,
    zoneType: zone.type,
    startLine: zone.startLine,
    endLine: zone.endLine
  };
}

function collectZoneAwareMatches(zones: Zone[], patterns: SecurityPattern[]): { flagged: PatternOccurrence[]; skipped: PatternOccurrence[] } {
  const flagged: PatternOccurrence[] = [];
  const skipped: PatternOccurrence[] = [];

  for (const zone of zones) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(zone.content)) {
        continue;
      }

      const occurrence = buildOccurrence(zone, pattern);
      if (zone.type === "prose") {
        flagged.push(occurrence);
      } else {
        skipped.push(occurrence);
      }
    }
  }

  return { flagged, skipped };
}

function uniqueLabels(matches: PatternOccurrence[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.label)) {
      continue;
    }
    seen.add(match.label);
    labels.push(match.label);
  }
  return labels;
}

function summarizeLineRange(matches: PatternOccurrence[]): Pick<LintIssue, "startLine" | "endLine"> {
  if (matches.length === 0) {
    return {};
  }

  return {
    startLine: Math.min(...matches.map((match) => match.startLine)),
    endLine: Math.max(...matches.map((match) => match.endLine))
  };
}

function buildSkippedPatterns(matches: PatternOccurrence[]): LintSkippedPattern[] | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  return matches.map((match) => ({
    label: match.label,
    zoneType: match.zoneType,
    startLine: match.startLine,
    endLine: match.endLine
  }));
}

function isSuppressed(context: LintContext, checkId: string): boolean {
  return context.suppressedCheckIds.has(checkId);
}

function runZoneAwareSecurityCheck(
  context: LintContext,
  zones: Zone[],
  options: {
    id: string;
    checkId: string;
    title: string;
    statusOnMatch: "fail" | "warn";
    patterns: SecurityPattern[];
    matchMessagePrefix: string;
    passMessage: string;
    suggestion: string;
  }
): LintIssue | null {
  if (isSuppressed(context, options.checkId)) {
    return null;
  }

  const matches = collectZoneAwareMatches(zones, options.patterns);
  const labels = uniqueLabels(matches.flagged);
  const skippedPatterns = buildSkippedPatterns(matches.skipped);

  if (labels.length > 0) {
    return {
      id: options.id,
      checkId: options.checkId,
      title: options.title,
      status: options.statusOnMatch,
      message: `${options.matchMessagePrefix}: ${labels.join(", ")}.`,
      suggestion: options.suggestion,
      ...summarizeLineRange(matches.flagged),
      skippedPatterns
    };
  }

  return {
    id: options.id,
    checkId: options.checkId,
    title: options.title,
    status: "pass",
    message: options.passMessage,
    skippedPatterns
  };
}

export function runSecurityChecks(context: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const skillText = context.skill.raw;
  const needsZoneParsing =
    !isSuppressed(context, "security:dangerous-commands") ||
    !isSuppressed(context, "security:exfiltration") ||
    !isSuppressed(context, "security:privilege-escalation");
  const zones = needsZoneParsing ? parseZones(skillText) : [];

  const dangerousCommandsIssue = runZoneAwareSecurityCheck(context, zones, {
    id: "security.dangerous-command-patterns",
    checkId: "security:dangerous-commands",
    title: "Dangerous Command Patterns",
    statusOnMatch: "fail",
    patterns: DANGEROUS_COMMAND_PATTERNS,
    matchMessagePrefix: "Potentially dangerous command instruction patterns found",
    passMessage: "No high-risk destructive or direct pipe-to-shell patterns detected.",
    suggestion: "Remove destructive/pipe-exec command examples or wrap them with explicit safety constraints."
  });
  if (dangerousCommandsIssue) {
    issues.push(dangerousCommandsIssue);
  }

  const exfiltrationIssue = runZoneAwareSecurityCheck(context, zones, {
    id: "security.exfiltration-patterns",
    checkId: "security:exfiltration",
    title: "Sensitive Data Exfiltration",
    statusOnMatch: "fail",
    patterns: EXFILTRATION_PATTERNS,
    matchMessagePrefix: "Possible sensitive data exfiltration patterns found",
    passMessage: "No obvious credential access/exfiltration instructions detected.",
    suggestion: "Remove instructions that access or transmit secrets/credential files."
  });
  if (exfiltrationIssue) {
    issues.push(exfiltrationIssue);
  }

  const privilegeEscalationIssue = runZoneAwareSecurityCheck(context, zones, {
    id: "security.privilege-escalation",
    checkId: "security:privilege-escalation",
    title: "Privilege Escalation Language",
    statusOnMatch: "warn",
    patterns: PRIVILEGE_ESCALATION_PATTERNS,
    matchMessagePrefix: "Potentially risky privilege/execution language detected",
    passMessage: "No obvious privilege-escalation language detected.",
    suggestion: "Prefer least-privilege execution and explicit approval steps for elevated commands."
  });
  if (privilegeEscalationIssue) {
    issues.push(privilegeEscalationIssue);
  }

  if (!isSuppressed(context, "security:missing-guardrails")) {
    const hasShellActivity = SHELL_ACTIVITY_PATTERNS.some((pattern) => pattern.test(skillText));
    if (hasShellActivity && !SAFETY_GUARDRAIL_PATTERN.test(skillText)) {
      issues.push({
        id: "security.safety-guardrails",
        checkId: "security:missing-guardrails",
        title: "Execution Safety Guardrails",
        status: "warn",
        message: "Shell/tool execution is present, but no explicit safety guardrails were detected.",
        suggestion: "Add guidance such as approval requirements, dry-run mode, scope checks, and redaction rules."
      });
    } else {
      issues.push({
        id: "security.safety-guardrails",
        checkId: "security:missing-guardrails",
        title: "Execution Safety Guardrails",
        status: "pass",
        message: hasShellActivity
          ? "Shell/tool execution instructions include at least one safety guardrail."
          : "No shell/tool execution instructions detected."
      });
    }
  }

  return issues;
}
