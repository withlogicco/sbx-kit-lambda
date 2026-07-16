# Project Guidance

## Overview

This repository defines the `lambda` Docker SBX kit. It installs Pi behind the
`codex` command and preserves native agent CLIs under `sbx-*` names.

## Development

- Validate kit changes with `sbx kit validate .`.
- Keep `README.md` aligned with `spec.yaml` installation, authentication, and
  command behavior.
- Keep Pi extensions self-contained TypeScript modules that Pi can load via
  `~/.pi/agent/extensions/`.
- Native subagents must be invoked through `sbx-codex` and `sbx-claude` by
  default; never invoke `codex` from the extension because it launches Pi.

## Subagents

- `/codex` and `/claude` support `plan`, `review`, and `code` roles.
- The outer SBX sandbox is the security boundary. Native subagents run with
  their non-interactive permission-bypass options.
- Plan/review work may run concurrently; code work against a shared workspace
  must be serialized.
- Codex uses `gpt-5.6-sol` and Claude uses `fable` for plan/review; coding
  defaults to Codex `gpt-5.6-terra` and Claude `opus` (override per role with
  `LAMBDA_<BACKEND>_<ROLE>_MODEL`, for example `LAMBDA_CLAUDE_CODE_MODEL=sonnet`).
- If Claude authentication is unavailable, tell the user to run
  `!sbx-claude auth login`.
