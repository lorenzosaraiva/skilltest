import { runEval, EvalPrompt, EvalResult } from "./eval-runner.js";
import { runLinter, LintReport } from "./linter/index.js";
import { parseSkillStrict } from "./skill-parser.js";
import { runTriggerTest, TriggerQuery, TriggerTestResult } from "./trigger-tester.js";
import { LanguageModelProvider } from "../providers/types.js";

export interface CheckThresholds {
  minF1: number;
  minAssertPassRate: number;
}

export interface CheckGates {
  lintPassed: boolean;
  triggerPassed: boolean | null;
  evalPassed: boolean | null;
  triggerF1: number | null;
  evalAssertPassRate: number | null;
  overallPassed: boolean;
}

export interface CheckRunResult {
  target: string;
  provider: string;
  model: string;
  graderModel: string;
  thresholds: CheckThresholds;
  continueOnLintFail: boolean;
  lint: LintReport;
  trigger: TriggerTestResult | null;
  eval: EvalResult | null;
  triggerSkippedReason?: string;
  evalSkippedReason?: string;
  gates: CheckGates;
}

export interface RunCheckOptions {
  provider: LanguageModelProvider;
  model: string;
  graderModel: string;
  numQueries: number;
  queries?: TriggerQuery[];
  prompts?: EvalPrompt[];
  minF1: number;
  minAssertPassRate: number;
  continueOnLintFail: boolean;
  verbose?: boolean;
  onStage?: (stage: string) => void;
}

function calculateEvalAssertPassRate(result: EvalResult): number {
  if (result.summary.totalAssertions === 0) {
    return 0;
  }
  return result.summary.passedAssertions / result.summary.totalAssertions;
}

export async function runCheck(inputPath: string, options: RunCheckOptions): Promise<CheckRunResult> {
  options.onStage?.("lint");
  const lint = await runLinter(inputPath);
  const lintPassed = lint.summary.failures === 0;

  let trigger: TriggerTestResult | null = null;
  let evalResult: EvalResult | null = null;
  let triggerSkippedReason: string | undefined;
  let evalSkippedReason: string | undefined;

  if (!lintPassed && !options.continueOnLintFail) {
    triggerSkippedReason = "Skipped because lint has failures (use --continue-on-lint-fail to override).";
    evalSkippedReason = "Skipped because lint has failures (use --continue-on-lint-fail to override).";
  } else {
    options.onStage?.("parse");
    let parsedSkill = null;
    try {
      parsedSkill = await parseSkillStrict(inputPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      triggerSkippedReason = `Skipped: skill could not be parsed strictly (${message}).`;
      evalSkippedReason = `Skipped: skill could not be parsed strictly (${message}).`;
    }

    if (parsedSkill) {
      options.onStage?.("trigger");
      trigger = await runTriggerTest(parsedSkill, {
        provider: options.provider,
        model: options.model,
        queries: options.queries,
        numQueries: options.numQueries,
        verbose: options.verbose
      });

      options.onStage?.("eval");
      evalResult = await runEval(parsedSkill, {
        provider: options.provider,
        model: options.model,
        graderModel: options.graderModel,
        prompts: options.prompts
      });
    }
  }

  const triggerF1 = trigger ? trigger.metrics.f1 : null;
  const evalAssertPassRate = evalResult ? calculateEvalAssertPassRate(evalResult) : null;
  const triggerPassed = triggerF1 === null ? null : triggerF1 >= options.minF1;
  const evalPassed = evalAssertPassRate === null ? null : evalAssertPassRate >= options.minAssertPassRate;
  const overallPassed = lintPassed && triggerPassed === true && evalPassed === true;

  return {
    target: inputPath,
    provider: options.provider.name,
    model: options.model,
    graderModel: options.graderModel,
    thresholds: {
      minF1: options.minF1,
      minAssertPassRate: options.minAssertPassRate
    },
    continueOnLintFail: options.continueOnLintFail,
    lint,
    trigger,
    eval: evalResult,
    triggerSkippedReason,
    evalSkippedReason,
    gates: {
      lintPassed,
      triggerPassed,
      evalPassed,
      triggerF1,
      evalAssertPassRate,
      overallPassed
    }
  };
}
