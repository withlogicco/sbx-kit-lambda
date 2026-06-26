# Lambda agent kit

Lambda is a Docker Sandbox agent kit based on the upstream Pi contrib kit. It
installs Pi with the `pi.dev` installer, exposes it as `lambda`, and includes
OpenAI Codex OAuth and OpenCode Go sandbox wiring.

## What it configures

- Agent kit metadata and entrypoint are named `lambda`.
- Installs Pi via `curl -fsSL https://pi.dev/install.sh | sh` logic.
- Adds a `/usr/local/bin/lambda` shim that delegates to the `pi` CLI.
- Exposes `OPENCODE_API_KEY` as a proxy-managed variable.
- Sets Codex-compatible environment variables (`BROWSER`, `CODEX_HOME`) and declares the OpenAI credential discovery sources sbx expects for Codex OAuth mode.
- Requests sbx OpenAI OAuth wiring so ChatGPT/Codex subscription auth is available when the host has `sbx secret set -g openai --oauth`.
- Creates Pi `openai-codex` placeholder OAuth auth on startup when `SBX_CRED_OPENAI_MODE=oauth`, allowing Pi to send Codex requests through the sbx proxy without storing the real OAuth token in the sandbox.
- Allows OpenAI Codex/ChatGPT traffic to `chatgpt.com` for the sbx OAuth proxy path.
- Allows and authenticates OpenCode Go traffic to `opencode.ai`.
- Allows `pi.dev` for the installer/update checks and `registry.npmjs.org` for
  npm package downloads used by the Pi installer.
- Adds agent memory instructing Lambda to run development commands locally in
  the sandbox, while running backing services such as PostgreSQL and Redis in
  Docker with ports exposed locally.

## Host-side setup

Store provider keys on the host as sandbox secrets:

```bash
# ChatGPT Plus/Pro Codex subscription via sbx OAuth proxy
sbx secret set -g openai --oauth

sbx secret set -g opencode-go
```

For OpenCode Go, you can also provide the key from your host shell for one-off runs:

```bash
export OPENCODE_API_KEY=...
```

## Usage

Kit install/startup changes are applied when the sandbox is created. If you
already have a `lambda-*` sandbox, remove it before testing kit changes:

```bash
sbx rm -f lambda-jobcard
```

Then create/run it again:

```bash
sbx run --kit ./docker-sandbox/lambda lambda
```

Inside the sandbox, start the agent with:

```bash
lambda
```

The shim delegates to Pi, so Pi CLI options still work:

```bash
lambda --provider openai-codex --model gpt-5.4-mini
lambda --provider opencode-go
```
