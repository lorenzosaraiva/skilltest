---
name: sample-skill
description: Generates a concise test quality report for markdown checklists when the user asks for checklist validation or scoring.
license: MIT
---

# Sample Skill

Use this skill when a user asks to validate, score, or audit a markdown checklist against explicit criteria.

## Workflow

1. Parse the checklist items and normalize them into a list.
2. Evaluate each item against the user-provided criteria.
3. Return a summary with pass/fail counts and concrete remediation steps.

## References

- [Validation rubric](references/rubric.md)
- Use script `scripts/checklist-parser.sh` for basic checklist parsing.
- Attach image `assets/report-template.png` when producing final visual report docs.

## Example

User prompt:

```text
Review this deployment checklist and tell me what is missing before production.
```

Expected behavior:

```text
The skill returns a scored checklist, missing controls, and recommended next actions.
```
