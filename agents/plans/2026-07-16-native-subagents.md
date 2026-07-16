# Native Codex and Claude subagents

## Scope

Add a Pi extension that delegates planning, review, and coding work to the
native Codex and Claude Code CLIs inside an SBX sandbox.

## Relevant files

- `files/home/.pi/agent/extensions/native-subagents.ts`
- `spec.yaml`
- `README.md`

## Steps

1. Add a self-contained Pi extension with direct commands and an LLM tool.
2. Stream native JSON output, retain bounded final output, and serialize shared
   workspace code runs.
3. Install Claude Code, expose it as `sbx-claude`, and install the extension in
   the kit.
4. Add Anthropic network capabilities and document its in-sandbox login flow.
5. Validate the SBX kit and TypeScript extension loading.

## Verification

- `sbx kit validate .`
- Load the extension with Pi and verify `/codex`, `/claude`, and
  `run_subagent` registration.

## Decisions

- Native commands run with permission bypass because SBX is the isolation
  boundary.
- No extra write confirmation or noninteractive write restriction.
- Native executable defaults are `sbx-codex` and `sbx-claude`; never fall
  back from Codex to Lambda's `codex` Pi wrapper.
- Plan/review use Codex `gpt-5.6-sol` and Claude `fable`; coding defaults to
  Codex `gpt-5.6-terra` and Claude `opus`, with per-role environment overrides.
