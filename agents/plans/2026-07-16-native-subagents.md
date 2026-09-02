# Native Codex and Claude subagents

## Scope

Add a Pi extension that delegates planning, review, and coding work to the
native Codex and Claude Code CLIs inside an SBX sandbox.

## Relevant files

- `files/home/.pi/agent/extensions/native-subagents.ts`
- `files/home/.pi/agent/models.json`
- `spec.yaml`
- `README.md`

## Steps

1. Add a self-contained Pi extension with direct commands and an LLM tool whose
   prompt guidance tells the model to delegate only after a clear user request.
2. Stream native JSON output, retain bounded final output, serialize shared
   workspace code runs, and expose concise model aliases with fixed effort.
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
- All roles default to Codex `sol` (`gpt-5.6-sol`, high) and Claude `opus`
  (Claude Opus 5, high). Alternatives are Codex `terra` (ultra), Codex `luna`
  (high), and Claude `sonnet` (Claude Sonnet 5, high), with per-role model and
  effort environment overrides.
- Slash commands are explicit requests. The model must not call `run_subagent`
  proactively, but once it calls the tool there is no second regex-based
  authorization check that can incorrectly reject the user's delegation.
