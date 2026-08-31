# Project Guidance

## Overview

This repository defines the `lambda` Docker SBX **agent kit** (`kind: sandbox`,
`schemaVersion: "2"`). It builds on `docker/sandbox-templates:shell-docker`,
installs Pi, and exposes it as the `lambda` agent binary. Because Lambda is its
own agent, `codex` and `claude` remain the real upstream CLIs.

## Development

- Validate kit changes with `sbx kit validate .` and review the resolved shape
  with `sbx kit inspect .`.
- Keep `README.md` aligned with `spec.yaml` installation, authentication, and
  command behavior.
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
  volume-mount ownership, npm proxy configuration, and config seeding that reads
  `WORKSPACE_DIR` or `HTTP_PROXY`.
- `sandbox.build` is declared for discoverability but sbx does not act on it.
  Expect one notice on every `sbx kit validate` / `sbx kit inspect` saying the
  image is taken from `sandbox.image`; that is not a regression. Declaring
  `build` without `image` fails validation outright, so `image` must always be
  set. The image is built by `.github/workflows/image.yml`, or locally with
  `docker build -t ghcr.io/withlogicco/sbx-kit-lambda:latest .` until CI
  publishes the tag.
- Native subagents must be invoked as `codex` and `claude`. Never shell out to
  `lambda` or `pi` from the subagent extension.
- Never start a native subagent proactively. The current user must clearly ask
  to run or delegate to Codex, Claude, or a native subagent.
- Once the user has clearly requested delegation, `run_subagent` must execute
  without a second authorization heuristic; responsibility stays with the
  calling model, and the native agent must not ask for permission.

## Authentication

- Proxy-managed OAuth does not activate for this kit. Docker gates OAuth
  interception on built-in provenance, which a third-party sandbox kit cannot
  have. Verified: the proxy never substitutes the OAuth sentinel.
- API-key injection does work, so host-managed auth is rebuilt on top of it.
  The host mints and refreshes tokens; the proxy substitutes them per request.
  Never store a real token in the sandbox or in kit files.
- `chatgpt-codex` must not be renamed to `openai`. `sbx secret set --command`
  cannot combine with `--oauth`, so reusing `openai` would replace the built-in
  Codex agent's OAuth registration and break plain `sbx run codex`.
- `apiKey.inject` overwrites whatever the named header contains, so a consumer
  only has to emit the header. Pi does that through `sbx-codex.ts`; the native
  Codex CLI through the `sandboxd` model provider in `~/.codex/config.toml`.
  Do not delete either: without them no header is sent and there is nothing for
  the proxy to substitute.
- Never seed `apiKeyHelper` into `~/.claude/settings.json`. It only works with
  provenance-backed OAuth interception; here it would make Claude Code send a
  dead sentinel and never prompt. `SBX_CRED_ANTHROPIC_MODE` is not a usable
  gate either — it reports `apikey` for an OAuth-only declaration.
- Pi's Anthropic provider is intentionally not wired up. It is outside the
  `--models` picker scope, and third-party harness usage bills per token from
  Anthropic extra usage rather than against the plan, so the subscription only
  pays off through the native `claude` CLI.
- Every credential a third-party v2 kit declares needs a user-approved binding.
  Adding a credential or a new inject domain means a new first-run prompt.

## Volumes

- Persist `~/.pi/agent/sessions`, `~/.claude`, and `~/.codex`.
- Never mount a volume over `~/.pi/agent` itself: the kit ships `models.json`
  and its extensions there, and a volume would shadow kit-owned files across
  kit updates.
- Volumes are keyed to the sandbox name and cannot be shared between sandboxes.
  Never treat a volume as a place to keep credentials; that would force a login
  per project. Credentials belong in the host secret store.

## Subagents

- `/codex` and `/claude` support `plan`, `review`, and `code` roles.
- The outer SBX sandbox is the security boundary. Native subagents run with
  their non-interactive permission-bypass options.
- Plan/review work may run concurrently; code work against a shared workspace
  must be serialized.
- Every role defaults to Codex `sol` (`gpt-5.6-sol`, high) and Claude `opus`
  (Claude Opus 5, high). Codex alternatives are `terra` (`gpt-5.6-terra`,
  ultra) and `luna` (`gpt-5.6-luna`, high); Claude also supports `sonnet`
  (Claude Sonnet 5, high). Override a role with
  `LAMBDA_<BACKEND>_<ROLE>_MODEL` and `LAMBDA_<BACKEND>_<ROLE>_EFFORT`, or the
  binary with `LAMBDA_<BACKEND>_EXECUTABLE`.
- If Claude authentication is unavailable, tell the user to run `!claude` and
  complete `/login` inside the sandbox.
