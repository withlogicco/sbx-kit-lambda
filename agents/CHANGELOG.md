# Agent Changelog

- 2026-08-31 — [Prebuild the Lambda agent image](plans/2026-08-31-prebuilt-image.md): move tool installation into a cached image published to GHCR, and settle the Claude Code credential source.
- 2026-08-31 — [Convert the mixin into an agent kit](plans/2026-08-31-agent-kit.md): make Lambda a schema v2 sandbox kit with its own `lambda` binary, OAuth for OpenAI and Anthropic, and native `codex`/`claude` CLIs.
- 2026-08-28 — [SBX schema v2 kit repair](plans/2026-08-28-v2-kit-repair.md): migrate the Lambda kit and restore Codex OAuth, Claude OAuth, OpenCode Go, and reliable delegated subagents.
- 2026-07-16 — [Native Codex and Claude subagents](plans/2026-07-16-native-subagents.md): add Pi orchestration and Claude Code support to the Lambda kit.
