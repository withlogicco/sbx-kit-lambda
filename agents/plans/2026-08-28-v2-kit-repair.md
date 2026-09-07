# Repair the Lambda kit for SBX schema v2

## Scope

Migrate the kit to the current schema v2 grammar and restore working Pi,
Codex OAuth, Claude Code OAuth, OpenCode Go, and native subagents.

## Relevant files

- `spec.yaml`
- `files/home/.pi/agent/extensions/native-subagents.ts`
- `files/home/.pi/agent/extensions/sbx-codex.ts`
- `README.md`
- `AGENTS.md`

## Implementation

1. Replace legacy `agentContext`, `caps`, and `commands` fields with
   `agentInstructions`, `permissions`, and `setup`, and require the built-in
   Codex base agent.
2. Keep the built-in Codex identity so host-managed OpenAI OAuth remains
   available to both Pi and native Codex. Preserve the native CLI as
   `sbx-codex` and use the `codex` entrypoint as the Pi launcher.
3. Declare OpenCode Go as a required proxy-managed v2 credential and inject it
   only into `opencode.ai` requests.
4. Install Claude Code, allow its OAuth endpoints, and document its supported
   in-sandbox login and the schema v2 mixin limitation.
5. Remove the subagent tool's regex authorization gate. Keep the prohibition
   on proactive delegation in model instructions and tool guidance.
6. Update setup, run, and troubleshooting documentation for current SBX.

## Verification

- `sbx kit validate .`
- Create a clean sandbox with `sbx create --kit . codex .`.
- Verify Pi, Codex, Claude Code, and GitHub CLI installation.
- Smoke-test Pi and native Codex with host-managed OpenAI OAuth.
- Verify an authenticated OpenCode Go request reaches account quota handling
  rather than failing authentication.
- Verify Pi loads the bundled model config and native-subagent extension.

## Decisions

- Keep the built-in `codex` base identity: schema v2 does not support
  proxy-managed OAuth for a third-party sandbox agent, including one that
  extends a built-in agent. A custom `lambda` sandbox would therefore break
  host-managed Codex OAuth.
- Claude subscription OAuth is performed inside the sandbox with
  `sbx-claude auth login`; no Anthropic API key is required. Schema v2 rejects
  OAuth declarations on mixins, so host interception is unavailable while the
  kit remains a Codex mixin.
- Native subagents bypass their own approval prompts because SBX is the
  security boundary.
