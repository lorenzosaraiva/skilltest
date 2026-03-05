# CLAUDE.md

## Project Overview

`skilltest` is a TypeScript CLI for validating Agent Skills (`SKILL.md` files). It provides:

- `lint`: static/offline quality checks
- `trigger`: model-based triggerability testing
- `eval`: end-to-end execution + grader-based scoring

The CLI is published as `skilltest` and built for `npx skilltest` usage.

## Architecture

- `src/index.ts`: commander setup, global flags, command registration
- `src/commands/`: command handlers and CLI-level error/output behavior
- `src/core/skill-parser.ts`: skill path resolution, frontmatter parsing, reference extraction
- `src/core/linter/`: lint check modules and orchestrator
- `src/core/trigger-tester.ts`: query generation + trigger simulation + metrics
- `src/core/eval-runner.ts`: prompt generation/loading + skill execution + grading loop
- `src/core/grader.ts`: structured grader prompt + JSON parse
- `src/providers/`: LLM provider abstraction (`sendMessage`) and provider implementations
- `src/reporters/`: terminal rendering and JSON output helper
- `src/utils/`: filesystem and API key config helpers

## Build and Test Locally

Install deps:

```bash
npm install
```

Build:

```bash
npm run build
```

Type-check:

```bash
npm run lint
```

Smoke test lint command:

```bash
node dist/index.js lint test-fixtures/sample-skill/
```

Help/version:

```bash
node dist/index.js --help
node dist/index.js --version
```

Trigger test (requires key):

```bash
ANTHROPIC_API_KEY=your-key node dist/index.js trigger test-fixtures/sample-skill/
```

## Key Design Decisions

- Minimal provider interface:
  - `sendMessage(systemPrompt, userMessage, { model }) => Promise<string>`
- Lint is fully offline and first-class.
- Trigger/eval rely on the same provider abstraction.
- JSON mode is strict:
  - no spinners
  - no colored output
  - stdout only JSON payload
- Error semantics:
  - lint failures => exit code `1`
  - runtime/config errors => exit code `2`

## Gotchas

- `trigger --num-queries` must be even for balanced positive/negative cases.
- OpenAI provider is intentionally a stub in v1 and throws `"OpenAI provider coming soon."`.
- Frontmatter is validated with both `gray-matter` and `js-yaml`; malformed YAML should fail fast.
- Keep file references relative to skill root; out-of-root refs are lint failures.
- If you modify reporter formatting, ensure JSON mode remains machine-safe.

## File-Level Logic Map

- Frontmatter checks: `src/core/linter/frontmatter.ts`
- Structure checks: `src/core/linter/structure.ts`
- Content heuristics: `src/core/linter/content.ts`
- Security heuristics: `src/core/linter/security.ts`
- Progressive disclosure: `src/core/linter/disclosure.ts`
- Compatibility hints: `src/core/linter/compat.ts`
- Trigger fake skill pool + scoring: `src/core/trigger-tester.ts`
- Eval grading schema: `src/core/grader.ts`

## Future Work (Not Implemented Yet)

- Real OpenAI provider implementation
- Config file support (`.skilltestrc`)
- Parallel execution
- HTML reporting
- Plugin linter rules
