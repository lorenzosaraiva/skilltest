# skilltest

[![npm version](https://img.shields.io/badge/npm-skilltest-blue)](https://www.npmjs.com/package/skilltest)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://img.shields.io/badge/ci-placeholder-lightgrey)](#cicd-integration)

The testing framework for Agent Skills. Lint, test triggering, and evaluate your SKILL.md files.

`skilltest` is a standalone CLI for the Agent Skills ecosystem (spec: https://agentskills.io). Think of it as pytest for skills.

## Demo

GIF coming soon.

![skilltest demo placeholder](https://via.placeholder.com/1200x420?text=skilltest+demo+gif+coming+soon)

## Why skilltest?

Agent Skills are quick to write but hard to validate before deployment:

- Descriptions can be too vague to trigger reliably.
- Broken paths in `scripts/`, `references/`, or `assets/` fail silently.
- You cannot easily measure trigger precision/recall.
- You do not know whether outputs are good until users exercise the skill.

`skilltest` closes this gap with one CLI and three modes.

## Install

Global:

```bash
npm install -g skilltest
```

Without install:

```bash
npx skilltest --help
```

Requires Node.js `>=18`.

## Quick Start

Lint a skill:

```bash
skilltest lint ./path/to/skill
```

Trigger test:

```bash
skilltest trigger ./path/to/skill --provider anthropic --model claude-sonnet-4-5-20250929
```

End-to-end eval:

```bash
skilltest eval ./path/to/skill --provider anthropic --model claude-sonnet-4-5-20250929
```

Example lint summary:

```text
skilltest lint
target: ./test-fixtures/sample-skill
summary: 25/25 checks passed, 0 warnings, 0 failures
```

## Commands

### `skilltest lint <path-to-skill>`

Static analysis only. Fast and offline.

What it checks:

- Frontmatter:
  - YAML presence and validity
  - `name` required, max 64, lowercase/numbers/hyphens, no leading/trailing/consecutive hyphens
  - `description` required, non-empty, max 1024
  - warn if no `license`
  - warn if description is weak on both what and when
- Structure:
  - warns if `SKILL.md` exceeds 500 lines
  - warns if long references (300+ lines) have no table of contents
  - validates referenced files in `scripts/`, `references/`, `assets/`
  - detects broken relative file references
- Content heuristics:
  - warns if no headers
  - warns if no examples
  - warns on vague phrases
  - warns on angle brackets in frontmatter
  - fails on obvious secret patterns
  - warns on empty/too-short body
  - warns on very short description
- Security heuristics:
  - fails on dangerous command patterns (destructive deletes, pipe-to-shell remote scripts)
  - fails on obvious sensitive-data exfiltration instructions
  - warns on privilege-escalation language (`sudo`, disable approvals, `require_escalated`)
  - warns when shell instructions exist without explicit safety guardrails
- Progressive disclosure:
  - warns if `SKILL.md` is large and no `references/` exists
  - validates references are relative and inside skill root
  - warns on deep reference chains
- Compatibility hints:
  - warns on provider-specific conventions such as `allowed-tools`
  - emits a likely compatibility summary

### `skilltest trigger <path-to-skill>`

Measures trigger behavior for your skill description with model simulation.

Flow:

1. Reads `name` and `description` from frontmatter.
2. Generates balanced trigger/non-trigger queries (or loads custom query file).
3. For each query, asks model to select one skill from a mixed list:
   - your skill under test
   - realistic fake skills
4. Computes TP, TN, FP, FN, precision, recall, F1.

Flags:

- `--model <model>` default: `claude-sonnet-4-5-20250929`
- `--provider <anthropic|openai>` default: `anthropic`
- `--queries <path>` use custom queries JSON
- `--num-queries <n>` default: `20` (must be even)
- `--save-queries <path>` save generated query set
- `--api-key <key>` explicit key override
- `--verbose` show full model decision text

### `skilltest eval <path-to-skill>`

Runs full skill behavior and grades outputs against assertions.

Flow:

1. Loads prompts from file or auto-generates 5 prompts.
2. Injects full `SKILL.md` as system instructions.
3. Runs prompt on chosen model.
4. Uses grader model to score each assertion with evidence.

Flags:

- `--prompts <path>` custom prompts JSON
- `--model <model>` default: `claude-sonnet-4-5-20250929`
- `--grader-model <model>` default: same as `--model`
- `--provider <anthropic|openai>` default: `anthropic`
- `--save-results <path>` write full JSON result
- `--api-key <key>` explicit key override
- `--verbose` show full model responses

## Global Flags

- `--help` show help
- `--version` show version
- `--json` output only valid JSON to stdout
- `--no-color` disable terminal colors

## Input File Formats

Trigger queries (`--queries`):

```json
[
  {
    "query": "Please validate this deployment checklist and score it.",
    "should_trigger": true
  },
  {
    "query": "Write a SQL migration for adding an index.",
    "should_trigger": false
  }
]
```

Eval prompts (`--prompts`):

```json
[
  {
    "prompt": "Validate this markdown checklist for a production release.",
    "assertions": [
      "output should include pass/warn/fail style categorization",
      "output should provide at least one remediation recommendation"
    ]
  }
]
```

## Output and Exit Codes

Exit codes:

- `0`: success with no lint failures
- `1`: lint failures present
- `2`: runtime/config/API/parse error

JSON mode examples:

```bash
skilltest lint ./skill --json
skilltest trigger ./skill --json
skilltest eval ./skill --json
```

## API Keys

Anthropic:

```bash
export ANTHROPIC_API_KEY=your-key
```

OpenAI:

```bash
export OPENAI_API_KEY=your-key
```

Override at runtime:

```bash
skilltest trigger ./skill --api-key your-key
```

Current provider status:

- `anthropic`: implemented
- `openai`: implemented

OpenAI quick example:

```bash
skilltest trigger ./path/to/skill --provider openai --model gpt-4.1-mini
skilltest eval ./path/to/skill --provider openai --model gpt-4.1-mini
```

Note:

- If you pass `--provider openai` and keep the Anthropic default model value, `skilltest` automatically switches to `gpt-4.1-mini`.

## CICD Integration

GitHub Actions example to lint skills on pull requests:

```yaml
name: skill-lint

on:
  pull_request:
    paths:
      - "**/SKILL.md"
      - "**/references/**"
      - "**/scripts/**"
      - "**/assets/**"

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npm run build
      - run: npx skilltest lint path/to/skill --json
```

Optional nightly trigger/eval:

```yaml
name: skill-eval-nightly

on:
  schedule:
    - cron: "0 4 * * *"

jobs:
  trigger-eval:
    runs-on: ubuntu-latest
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npm run build
      - run: npx skilltest trigger path/to/skill --num-queries 20 --json
      - run: npx skilltest eval path/to/skill --prompts path/to/prompts.json --json
```

## Local Development

```bash
npm install
npm run lint
npm run build
node dist/index.js --help
```

Smoke tests:

```bash
node dist/index.js lint test-fixtures/sample-skill/
node dist/index.js trigger test-fixtures/sample-skill/ --num-queries 2
node dist/index.js eval test-fixtures/sample-skill/ --prompts test-fixtures/eval-prompts.json
```

## Release Checklist

```bash
npm run lint
npm run build
npm run test
npm pack --dry-run
npm publish --dry-run
```

Then publish:

```bash
npm publish
```

## Contributing

Issues and pull requests are welcome. Include:

- clear reproduction steps
- expected vs actual behavior
- sample `SKILL.md` or fixtures when relevant

## License

MIT
