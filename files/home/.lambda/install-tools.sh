#!/bin/sh
# Installs Lambda's agent binaries.
#
# Two consumers share this script so tool installation has a single source of
# truth:
#   - Dockerfile, to bake the tools into a prebuilt image
#   - spec.yaml `setup.install`, so the kit also works on a plain
#     docker/sandbox-templates:shell-docker base
#
# Every step is guarded, so running this against an image that already has the
# tools is a no-op. It must stay idempotent for that reason: `setup.install`
# runs it on every sandbox creation.
#
# Runs as the agent user (UID 1000). The base image ships an agent-owned
# /usr/local/share/npm-global on PATH, so `npm install -g` needs no sudo.
set -eu

if ! command -v pi >/dev/null 2>&1; then
  i=0
  while [ "$i" -lt 5 ]; do
    if curl -fsSL https://pi.dev/install.sh -o /tmp/pi-install.sh && sh /tmp/pi-install.sh; then
      break
    fi
    i=$((i + 1))
    echo "Retrying Pi install ($i/5)..." >&2
    sleep 2
  done
  rm -f /tmp/pi-install.sh
  [ "$i" -lt 5 ]
fi

# `lambda` is this kit's agent binary: a symlink to pi. Pi's provider and model
# flags come from `sandbox.command`, never from a wrapper script here.
pi_path="$(command -v pi)"
ln -sfn "$pi_path" "$(dirname "$pi_path")/lambda"

# Native CLIs behind the /codex and /claude subagents. They keep their real
# names because Lambda runs as its own `lambda` binary.
command -v codex >/dev/null 2>&1 || npm install -g @openai/codex
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

# Webi is this project's default for standalone CLI tools. It installs into
# ~/.local/bin, which is also on PATH.
if [ ! -x "$HOME/.local/bin/gh" ]; then
  installer="$(mktemp)"
  curl -fsSL --retry 4 https://webi.sh/gh -o "$installer"
  sh "$installer"
  rm -f "$installer"
fi

lambda --version
codex --version
claude --version
"$HOME/.local/bin/gh" --version
