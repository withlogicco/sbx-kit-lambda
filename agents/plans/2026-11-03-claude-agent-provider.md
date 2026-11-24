# Claude Agent provider for Pi

## Scope

Use Claude models in Pi through the sandbox's Claude Code subscription by
driving the installed `claude` binary with the Claude Agent SDK, modelled on
OpenCode's `claude-agent` provider. Pi keeps its own tools, history,
permissions, and compaction; Claude Code is only the model transport.

References (sandbox-local clones under `~/Developer/github.com/`):

- OpenCode: `anomalyco/opencode/packages/core/src/plugin/provider/claude-agent/`
  and `specs/v2/claude-agent-provider.md`.
- SDK types: `anthropics/claude-agent-sdk-npm/package/sdk.d.ts` (0.3.317,
  parity with Claude Code 2.1.317). The GitHub repo has no sources.
- Pi: `earendil-works/pi`, `docs/custom-provider.md`, `packages/ai/src/types.ts`.

## Decisions

- Policy: proceed. The kit does not offer claude.ai login; it reuses the
  user's host-managed `claude setup-token` already injected for native Claude
  Code via `CLAUDE_CODE_OAUTH_TOKEN`. No new secret, binding, or domain.
- Separate provider `claude-agent` ("Claude Agent"; SDK branding forbids
  "Claude Code"). `anthropic/*` stays on the platform API key.
- System prompt: Claude Code `claude_code` preset, with Pi's system prompt
  (including AGENTS.md and skills) appended. Revisit replacing it later.
- History divergence: restart a fresh Claude session and resend unseen
  history as a `<conversation-checkpoint>` user message. No session forking
  in the first version.

## Steps

0. Spike (throwaway script in the sandbox, not committed):
   - `query()` with streaming input, `pathToClaudeCodeExecutable` set to the
     installed `claude`, SDK installed with `--omit=optional`.
   - Confirm subscription auth through the placeholder, the preset+append
     prompt, a parked MCP tool across two "steps", `interrupt()`, usage and
     stop-reason fields, and `initializationResult().models`.
1. Extension `files/home/.pi/agent/extensions/claude-agent/` (`index.ts`,
   small modules, `package.json` pinning the SDK and MCP server SDK):
   - `pi.registerProvider("claude-agent", { api: "claude-agent-sdk", models,
     streamSimple })`. Models: Sonnet, Opus, Fable aliases (no Haiku), cost 0,
     no `promptCache` (keeps Pi's cache warmer off), thinking levels mapped to
     SDK `effort` (`low`..`max`).
   - Query options as OpenCode's `query-options.ts`: `tools: []`,
     `settingSources: []`, `strictMcpConfig`, `skills: []`,
     `permissionMode: "dontAsk"`, `allowedTools: ["mcp__pi__*"]`,
     `verbatimPrompts`, adaptive summarized thinking, hooks disabled, and the
     isolation env (no CLAUDE.md, auto memory, auto compaction, tool search,
     advisor, fallbacks; clear `CLAUDE_CODE_SIMPLE`,
     `CLAUDE_CODE_EFFORT_LEVEL`, `MCP_TOOL_TIMEOUT`).
   - Tool bridge: Pi tools (from `getCurrentTools`) exposed by an in-process
     low-level MCP server named `pi` with raw JSON schemas; PreToolUse hook
     supplies the call ID; handlers park until the next `streamSimple` call
     delivers matching `toolResult` messages. Tools restart the process when
     their set changes.
   - Stream conversion: SDK `stream_event`s to Pi text/thinking/toolcall
     events; end the step with `toolUse` at `message_stop` when Pi tools were
     called, otherwise on `result`. Usage keeps the max per API message; input
     is the last call's. Abort maps to `interrupt()` and an `aborted` result.
   - Sessions: one live process per Pi `sessionId`; side calls (no session or
     no tools, e.g. compaction) run one-shot with `persistSession: false` and
     Pi's prompt as the system prompt.
   - Lifecycle: no processes in the factory; stop all on `session_shutdown`;
     5-minute idle stop after `agent_settled`, clearing parked tools.
2. History sync: record hashes of the history Claude has seen per Pi session
   (Pi custom entry). Matching prefix sends only new user input or tool
   results; otherwise restart with a checkpoint. Missing Claude transcripts
   (e.g. after `/restore`) take the same path.
3. Packaging and docs:
   - `install-tools.sh`: guarded, idempotent `npm ci --omit=optional` for the
     extension's dependencies, stamped by lockfile. The Dockerfile copies
     only the manifests so the image bakes them.
   - Models in `settings.json` `enabledModels`; typecheck via `tests/`.
   - README and AGENTS.md: provider, auth path, limitations.

## Checks

- `sbx kit validate .` and `sbx kit inspect .`.
- `cd tests && npm ci && npm test && npm run typecheck`. Decided: no
  fake-`claude` test suite; live checks cover process behavior. Focused
  stream-conversion regressions cover thinking events and per-step usage in CI.
- Manual: text reply, multi-tool turn, abort mid-tool, compaction, model and
  thinking switch, switching between `claude-agent` and another provider in
  one session, unauthenticated failure message.

## Findings (step 1)

- Anthropic classifies requests by system-prompt content. Appending Pi's
  prompt (its `docs` section) makes the API answer `400 Third-party apps now
  draw from your extra usage, not your plan limits`. Same SDK request with a
  trivial append, MCP tools, or no client-app tag passes on plan limits.
- Decided: follow OpenCode's split (`system-prompt.ts`). Claude Code's
  preset is the harness prompt; Pi contributes only user instructions
  (`rules`, `addendum`, `project_context`, `skills`, extension sections, a
  custom SYSTEM.md preamble as role) and drops its harness sections
  (default `preamble`, `tools`, `docs`, `cwd`). Verified on plan limits.
- Pi has no per-provider retry opt-out (it matches error text), so errors
  and aborts reset the session and the next step rebuilds from Pi's history.
- Pi's compaction reuses the session id with `cacheRetention: "none"`; such
  calls run in a throwaway process.
- Verified live: single turn, parallel tool calls, multi-step parked turns,
  follow-up turns on one process, Opus, compaction plus rebuild, abort plus
  recovery, AGENTS.md reaching Claude, live model and effort switch on a
  running process (no restart), image input, summarized thinking, a
  foreign-model turn mid-session (rebuild, history kept), and joining an
  existing Pi session. Adaptive thinking skips trivial prompts
  (`thinking_tokens: 0`); that is not a bug. `/tree` verified interactively
  (rebuilt from the chosen branch); a rebuild there is acceptable.

## Open

- Whether Pi's prompt can replace the preset under the subscription.
- Session forking on Pi `/tree` and `/fork` edits, as OpenCode does.
- Live model discovery and context windows from `getContextUsage`.
