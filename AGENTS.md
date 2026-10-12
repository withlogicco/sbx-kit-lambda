# Project Guidance

## Overview

This repository defines the `lambda` Docker SBX **agent kit** (`kind: sandbox`,
`schemaVersion: "2"`). It builds on `docker/sandbox-templates:shell-docker`,
installs Pi, and exposes it as the `lambda` agent binary. Because Lambda is its
own agent, `codex` and `claude` remain the real upstream CLIs.

## Development

- Make changes in a dedicated worktree under `.worktrees/`, not the main checkout.
- Validate kit changes with `sbx kit validate .` and review the resolved shape
  with `sbx kit inspect .`.
- Keep `README.md` aligned with `spec.yaml` installation, authentication, and
  command behavior.
- Keep Planning and Communication rules identical to `spec.yaml`'s agent instructions.
- Keep rules simple and general; omit one-off demo instructions.
- Keep Pi extensions self-contained TypeScript modules that Pi auto-discovers
  from `~/.pi/agent/extensions/`.
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
- `chatgpt-codex` must not be renamed to `openai`, and `claude-code` must not be
  renamed to `anthropic`. `sbx secret set --command` cannot combine with
  `--oauth`, so reusing a built-in service id would replace that agent's OAuth
  registration and break plain `sbx run codex` / `sbx run claude`.
- `apiKey.inject` overwrites whatever the named header contains, so a consumer
  only has to emit that header. Rules on the same domain can serve different
  credentials when they target different headers. Pi's Codex header comes
  from `sbx-codex.ts`; its Anthropic header comes from built-in API-key auth
  configured in `models.json`. Native Codex uses the `sandboxd` model provider
  in `~/.codex/config.toml`. Keep these header-emitting configurations intact.
- Never seed `apiKeyHelper` into `~/.claude/settings.json`. It only works with
  provenance-backed OAuth interception; here it would make Claude Code send a
  dead sentinel and never prompt. `SBX_CRED_ANTHROPIC_MODE` is not a usable
  gate either — it reports `apikey` for an OAuth-only declaration.
- Pi's `anthropic/*` models use built-in API-key auth with `anthropic.apiKey`
  set to `$LAMBDA_ANTHROPIC_API_KEY` in `models.json`, and the `anthropic`
  credential injected into `x-api-key` by the proxy. Do not add a custom
  Anthropic auth extension: API-key auth only needs configuration.
- Keep `claude-code` exclusively for native Claude Code (including Pi's Claude
  subagent), using `CLAUDE_CODE_OAUTH_TOKEN` and `Authorization` injection.
  Never make Pi consume that subscription credential or replace it with the
  platform key. Use `LAMBDA_ANTHROPIC_API_KEY` for the platform declaration,
  not `ANTHROPIC_API_KEY`, which native Claude also reads. Verified with Claude
  Code 2.1.289 `auth status`: when both that variable and the subscription token
  are set, it selects `api_key`. Prefer the isolated variable over adding
  environment filtering to Claude subagents.
- Every credential a third-party v2 kit declares needs a user-approved binding.
  Adding a credential or a new inject domain means a new first-run prompt.

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
- Linked launches with `--separate-git-dir` are out of scope. Concurrent duplicate
  `.lambda/` exclusions are harmless; do not add cross-process locking.
- A "turn" is a Pi agent run, not Pi's per-request `turn_start`/`turn_end`.
  Start on the first `agent_start` of a run (it repeats on retries) and end on
  `agent_settled`. The rate-limit resume starts a run without
  `before_agent_start`, so never require a prompt to write the start entry.
- Run `cd tests && npm ci && npm test && npm run typecheck` after changing it.

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
- If Claude authentication is unavailable, tell the user to run `!claude` and
  complete `/login` inside the sandbox.
