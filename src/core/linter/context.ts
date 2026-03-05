import { FrontmatterParseResult, SkillFileContext } from "../skill-parser.js";

export interface LintContext {
  skill: SkillFileContext;
  frontmatter: FrontmatterParseResult;
}
