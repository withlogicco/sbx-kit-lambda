# Project Guidance

## Overview

This repository defines the `lambda` Docker SBX **agent kit** (`kind: sandbox`,
`schemaVersion: "2"`). It builds on `docker/sandbox-templates:shell-docker`,
installs Pi, and exposes it as the `lambda` agent binary. Because Lambda is its
own agent, `codex` and `claude` remain the real upstream CLIs.

## Development

- Develop in task-specific worktrees under `.worktrees/`; keep their changes
  separate. After finishing an update, combine both worktrees' changes into the
  main worktree so it holds the unified code. Do not create commits unless asked.
- Validate kit changes with `sbx kit validate .` and review the resolved shape
  with `sbx kit inspect .`.
- Keep `README.md` aligned with `spec.yaml` installation, authentication, and
  command behavior.
- Keep Planning and Communication rules identical to `spec.yaml`'s agent instructions.
- Keep rules simple and general; omit one-off demo instructions.
- Keep Pi extensions self-contained TypeScript modules that Pi auto-discovers
  from `~/.pi/agent/extensions/`.
- Keep shared Pi preferences and model defaults in
  `files/home/.pi/agent/settings.json`, not `sandbox.command` flags. Omit
  installation-specific state such as `deviceId` and `lastChangelogVersion`.
- Verify model IDs against live Pi and provider catalogs. Keep at least two
  models per provider: fast/cheap and recommended, plus a top-capability tier
  where useful (e.g. Codex and Claude). Preserve older models with distinct
  speed/cost value, such as Grok 4.3; newest alone is not the selection rule.
- Claude tiers are Sonnet (cheap/fast), Opus (default), and Fable (extreme),
  for both `anthropic/*` and `claude-agent/*`. Do not include Haiku in the
  curated model scope.
- OpenCode Go keeps cheap/default pairs per selected lab (Kimi, GLM, DeepSeek,
  Qwen) and GPT-6 Luna as a Codex fallback. Add Grok 4.3 there only if Go's
  catalog lists it; keep the direct xAI choice independently.
- Indent with spaces, never tabs. `.editorconfig` is authoritative: two spaces
  for TypeScript, JavaScript, JSON, and YAML.
- Install supported standalone CLI tools with Webi; use an upstream installer
  or package manager only when Webi does not provide the tool. Pi, Codex, and
  Claude Code are the documented exceptions.
- `npm install -g` runs as the agent user (UID 1000): the base image ships an
  agent-owned `/usr/local/share/npm-global` that is already on `PATH`.
- Tool installation belongs in `files/home/.lambda/install-tools.sh` and
  nowhere else. Both the `Dockerfile` and `setup.install` run that script, so
  never duplicate an install step into either one. Keep every step guarded and
  idempotent: `setup.install` runs it on every sandbox creation, and it must
  no-op against a prebuilt image.
- Beyond that script, `setup.install` is for runtime-dependent work only:
  npm proxy configuration and config seeding that reads `WORKSPACE_DIR` or
  `HTTP_PROXY`.
- `sandbox.build` is declared for discoverability but sbx does not act on it.
  Expect one notice on every `sbx kit validate` / `sbx kit inspect` saying the
  image is taken from `sandbox.image`; that is not a regression. Declaring
  `build` without `image` fails validation outright, so `image` must always be
  set. The image is built by `.github/workflows/image.yml`, or locally until CI
  publishes the tag — and a local `docker build` alone is not enough: the
  sandbox runtime has its own image store, so the build must be handed over
  with `docker save ... -o file.tar` followed by `sbx template load file.tar`,
  or creation fails with `403 Forbidden: pull failed`.
- Native subagents must be invoked as `codex` and `claude`. Never shell out to
  `lambda` or `pi` from the subagent extension.
- Never start a native subagent proactively. The current user must clearly ask
  to run or delegate to Codex, Claude, or a native subagent.
- Once the user has clearly requested delegation, `run_subagent` must execute
  without a second authorization heuristic; responsibility stays with the
  calling model, and the native agent must not ask for permission.

## Communication

- Be laconic.

## Planning

- Plan only when asked; save only when asked.
- Save as `agents/plans/YYYY-MM-DD-{slug}.md`.
- Keep plans laconic: scope, steps, checks, decisions.
- Keep useful plans; delete trivial ones.

## Authentication

- Proxy-managed OAuth does not activate for this kit. Docker gates OAuth
  interception on built-in provenance, which a third-party sandbox kit cannot
  have. Verified: the proxy never substitutes the OAuth sentinel.
- API-key injection does work, so host-managed auth is rebuilt on top of it.
  The host mints and refreshes tokens; the proxy substitutes them per request.
  Never store a real token in the sandbox or in kit files.
- Set explicit `--refresh on-demand` for every command-backed secret, including
  API keys. Do not rely on the differing sbx defaults (`set`: `55m`;
  `set-custom`: `on-demand`). Re-resolving a secret does not itself renew the
  upstream credential.
- Subscriptions are optional. Every Pi-backed credential is minted on the host
  by `pi auth print-bearer-token` or `pi auth print-api-key` and injected by
  the proxy. Never store a real token in the sandbox, and never require a
  subscription for the kit to start.
- Keep `chatgpt-codex` separate from `openai`, and `lambda-xai` separate from
  `xai`. `sbx secret set --command` cannot combine with `--oauth`; do not
  overwrite built-in OAuth registrations to supply Lambda tokens. sbx v0.48.0
  permits only one kit credential per host.
- `apiKey.inject` overwrites the named header on every request to that host.
  Do not use it for two consumers that need different secrets on one host.
  Pi's Codex header comes from `sbx-codex.ts`. Native Codex uses the
  `sandboxd` model provider in `~/.codex/config.toml`. Keep those intact.
- Never seed `apiKeyHelper` into `~/.claude/settings.json`. It only works with
  provenance-backed OAuth interception; here it would make Claude Code send a
  dead sentinel and never prompt. `SBX_CRED_ANTHROPIC_MODE` is not a usable
  gate either — it reports `apikey` for an OAuth-only declaration.
- Do not declare a kit credential for `api.anthropic.com`. Both consumers use
  distinct custom secrets so only each client's placeholder is replaced.
  sbx v0.48.0 also auto-injects a stored built-in `anthropic` API key even when
  absent from the kit. Preserve globals during diagnosis. Fresh v0.49.2
  sandboxes passed custom-key auth and unauthenticated 401 checks without the
  legacy empty-source override; do not reapply it blindly. Old sandboxes may
  retain stale injection rules: back up sessions before recreation. Local CLI
  auth status alone cannot prove proxy isolation.
- Pi's `anthropic/*` models use the platform API key from host Pi. `models.json`
  sets `anthropic.apiKey` to `$LAMBDA_ANTHROPIC_API_KEY`. The placeholder must
  not contain `sk-ant-oat`. Do not add a custom Anthropic auth extension.
- Native Claude Code, including `/claude`, reads `CLAUDE_CODE_OAUTH_TOKEN` and
  emits `Authorization`. That placeholder must contain `sk-ant-oat`, and the
  secret is a host `claude setup-token` subscription token, not `pi auth` and not
  the platform key. Do not set `ANTHROPIC_API_KEY`: Claude Code 2.1.289 selects
  an API key over the subscription token when both standard variables are present.
  Do not add `service: claude-code`; it would take the host back.
- Store the long-lived `claude setup-token` result in the dedicated host
  Keychain item `Lambda Claude Code-token`, not in sandbox files or the kit.
  Read it with a custom command secret and explicit `--refresh on-demand`.
  Keep an existing placeholder when changing its source, and migrate scoped
  overrides separately. Replace expired/revoked tokens manually with
  `claude setup-token` and update that item. Do not use the short-lived bearer
  in `Claude Code-credentials`, automatic model invocations, or direct OAuth
  refresh helpers. Host login/status does not replace the dedicated item.
  Prompt for the token with `security add-generic-password ... -w` (`-w` last);
  never pass it in arguments, shell history, or chat.
- Pi's `xai/*` models use `LAMBDA_XAI_TOKEN`, not `XAI_API_KEY`, so a platform
  key cannot replace the host-minted subscription bearer.
- Every credential a third-party v2 kit declares needs a user-approved binding.
  Adding a credential or a new inject domain means a new first-run prompt.

## Claude Agent provider

- `claude-agent/*` runs Claude on the subscription by driving the installed
  `claude` binary with the Claude Agent SDK. Auth is native Claude's
  `CLAUDE_CODE_OAUTH_TOKEN`; never add a secret, binding, or domain for it.
  Keep it a separate provider from `anthropic/*` (platform key). SDK branding
  rules forbid naming it "Claude Code".
- Claude Code's preset is the system prompt. Pi contributes only user
  instructions; never forward Pi's harness prompt, tool list, or docs. Claude's
  built-in tools, skills, and setting sources stay disabled; Pi's tools are the
  in-process `mcp__pi__*` server.
- Pi's history is the source of truth. On divergence, errors, or aborts, start
  a fresh process with a checkpoint; do not fork Claude sessions. Requests with
  `cacheRetention: "none"` or no session id (compaction, branch summaries) run
  in a throwaway process.
- Start no process in the extension factory; stop processes on
  `session_shutdown`. Do not set `promptCache`: Pi's cache warmer would spawn
  `claude`.
- Its npm dependencies install via `install-tools.sh` with
  `npm ci --omit=optional`, using `pathToClaudeCodeExecutable` instead of the
  SDK's bundled binary. Never commit `node_modules`; the SDK is not
  redistributable.

## Session backups

- `/backup` and `/restore` default to `.lambda/backup` in the current working
  directory. Back up session history only, never credentials or the whole Pi
  agent directory.

## Session status

- `session-status.ts` writes `<main checkout>/.lambda/sessions/<session-id>.jsonl`
  for an external dashboard, regardless of where Pi launches. Its path, entry
  fields, and state names are a shared contract: coordinate changes with that
  repo and provide a dashboard handoff.
- Pi's `ctx.cwd` is the launch directory; shell `cd` and worktree edits do not
  change it. Never infer the active worktree from that directory. Every agent
  report includes required repository-relative `worktree` metadata; `.` means
  main. Hooks omit it, and the dashboard folds history to determine grouping
  independently of current state.
- Pi's footer restores this session's worktree and last reported summary from
  the central JSONL. Start/warning hooks update state, not that title or worktree.
  Bold the worktree; leave `in_progress` uncolored, use green for `needs_input`
  and `needs_review`, and yellow for warning states. UI-only rendering must not
  create storage or rename the user's Pi session.
- Only the turn-end hook writes `warning`; `report_status` must reject it.
- Leave `in_progress` unchanged on process exit; the dashboard owns stale detection.
- Exclude runtime state with the broad `.lambda/` pattern in `info/exclude`.
  Keep kit assets under `files/home/.lambda/` visible with a narrow override in
  the repository `.gitignore`; do not migrate or rewrite existing exclude rules.
- Linked launches with `--separate-git-dir` are out of scope. Concurrent duplicate
  `.lambda/` exclusions are harmless; do not add cross-process locking.
- A "turn" is a Pi agent run, not Pi's per-request `turn_start`/`turn_end`.
  Start on the first `agent_start` of a run (it repeats on retries) and end on
  `agent_settled`. The rate-limit resume starts a run without
  `before_agent_start`, so never require a prompt to write the start entry.
- Run `cd tests && npm ci && npm test && npm run typecheck` after changing it
  or the `claude-agent` extension.

## Sandbox state

- Do not declare volumes or add custom persistence machinery. Agent state lives
  in the sandbox's ordinary filesystem and survives stops and restarts.
- Local SBX deletes its volumes along with the sandbox. Never claim that
  sessions survive `sbx rm` or `lambda --reset`; require a backup before
  recommending deletion when state matters.
- Credentials belong in the host secret store, not the sandbox.

## Subagents

- `/codex` and `/claude` support `plan`, `review`, and `code` roles.
- The outer SBX sandbox is the security boundary. Native subagents run with
  their non-interactive permission-bypass options.
- Plan/review work may run concurrently; code work against a shared workspace
  must be serialized.
- Every role defaults to Codex `sol` (`gpt-6.1-sol`, high) and Claude `opus`
  (Claude Opus 5, high). Codex alternatives are `astra` (`gpt-6-astra`, high)
  and `luna` (`gpt-6-luna`, high); Claude also supports `sonnet`
  (Claude Sonnet 5, high). Override a role with
  `LAMBDA_<BACKEND>_<ROLE>_MODEL` and `LAMBDA_<BACKEND>_<ROLE>_EFFORT`, or the
  binary with `LAMBDA_<BACKEND>_EXECUTABLE`.
- If Claude authentication is unavailable, ask the user to replace the host
  setup token in Keychain (see Authentication), then retry. Do not recommend
  sandbox-local `/login` for this host-managed setup.
