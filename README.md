# lambda SBX agent kit

Lambda is a Docker Sandboxes **agent kit**: it defines its own sandbox agent
rather than layering on top of a built-in one. The agent binary is `lambda`, a
symlink to [Pi](https://pi.dev), launched with Lambda's provider and model
defaults:

```bash
sbx run lambda --kit git+https://github.com/withlogicco/sbx-kit-lambda
```

Because Lambda is its own agent, the native CLIs keep their real names:

```text
lambda      # Lambda (Pi)
codex       # native Codex CLI
claude      # native Claude Code CLI
```

There are no `sbx-codex` / `sbx-claude` shims any more. Those existed only
because the previous mixin had to hijack the `codex` entrypoint.

## Authentication

Proxy-managed OAuth does not work for third-party sandbox agent kits — Docker
gates OAuth interception on built-in provenance, and this kit cannot have it
(see `agents/plans/2026-08-31-agent-kit.md` for the verification). API-key
injection *does* work, so Lambda rebuilds host-managed auth on top of it: the
host mints and refreshes the token, and the sandbox proxy substitutes it into
outbound requests. **No token enters the sandbox, and no credential is
per-project — one setup serves every sandbox you ever create.**

### One-time host setup

```bash
# ChatGPT subscription, minted fresh on every request by Pi on the host
sbx secret set chatgpt-codex \
  --command 'pi auth print-bearer-token --provider openai-codex' \
  --refresh on-demand

# Claude subscription: generate a long-lived token, then store it
claude setup-token
sbx secret set claude-code --token

# OpenCode Go, and GitHub for gh and git over HTTPS
sbx secret set opencode-go
sbx secret set github --command 'gh auth token'
```

The first run of the kit asks you to approve a
[credential binding](https://docs.docker.com/ai/sandboxes/configuration/credentials/)
for each service and the domains it may inject into. Approvals live in
`credentials.yaml` on the host and are reused by every later sandbox.

### How each consumer reaches its credential

| Consumer | Emits | Proxy injects into | Credential |
| -------- | ----- | ------------------ | ---------- |
| Pi (`lambda`) | Authorization header via `sbx-codex.ts` | `chatgpt.com` | `chatgpt-codex` |
| Native `codex` | Authorization header via the `sandboxd` model provider in `~/.codex/config.toml` | `chatgpt.com` | `chatgpt-codex` |
| Native `claude` | Authorization bearer from `CLAUDE_CODE_OAUTH_TOKEN` | `api.anthropic.com` | `claude-code` |
| Pi's OpenCode Go provider | `OPENCODE_API_KEY` | `opencode.ai` | `opencode-go` |
| `gh`, `git` | `GH_TOKEN` | `api.github.com`, `github.com`, `raw.githubusercontent.com` | `github` |

Both ChatGPT consumers only need to *emit* an `Authorization` header —
`apiKey.inject` overwrites whatever it contains, so the placeholder values in
`sbx-codex.ts` and `config.toml` are not secrets and are never sent upstream.

> [!NOTE]
> The `chatgpt-codex` service is deliberately not named `openai`. `sbx secret
> set --command` cannot be combined with `--oauth`, so reusing the `openai`
> service id would replace the built-in Codex agent's OAuth registration and
> break plain `sbx run codex`.

### Why not the subscription's own OAuth

Neither subscription can be used with an API key: ChatGPT Plus/Pro and Claude
Pro/Max are OAuth-only, and an OpenAI or Anthropic API key is a separate,
pay-per-token account. The host-minted-token approach above is what keeps the
subscription in play without a per-sandbox browser login.

If you would rather log in inside the sandbox, that still works and persists in
the `~/.claude` and `~/.codex` volumes — but only for that one sandbox, and the
real token then lives in the VM.

Global credentials are applied when a sandbox is created. Recreate an existing
sandbox after adding or changing one.

## Native subagents

Pi provides direct commands and a `run_subagent` tool:

```text
/codex plan map the authentication flow
/claude review review the current working tree
/codex code implement the approved plan
```

`plan` and `review` runs are instructed to remain read-only and may run
concurrently. `code` runs can modify the shared workspace and are serialized.
Native CLIs run with their permission-bypass options because the outer SBX
sandbox is the security boundary.

Lambda's model must never delegate proactively. It may call `run_subagent` only
after the current user clearly asks for Codex, Claude, or a native subagent.
Once called, the tool does not apply a second regex authorization check or
reject the model's interpretation of that request; the delegated agent proceeds
without asking for another approval. `/codex` and `/claude` are themselves
explicit requests.

All roles default to `sol` (`gpt-5.6-sol`, high) for Codex and `opus` (Claude
Opus 5, high) for Claude. Available aliases are:

- Codex: `sol` (high), `terra` (ultra), and `luna` (high)
- Claude: `opus` (high) and `sonnet` (Claude Sonnet 5, high)

Choose an alias after the role, for example:

```text
/codex code terra implement the approved plan
/claude review sonnet review the current tree
```

Override any role with `LAMBDA_<BACKEND>_<ROLE>_MODEL` and
`LAMBDA_<BACKEND>_<ROLE>_EFFORT`. `LAMBDA_CODEX_EXECUTABLE` and
`LAMBDA_CLAUDE_EXECUTABLE` override which binary is invoked. The
`run_subagent` tool accepts the same optional model aliases.

Pi starts on `openai-codex/gpt-5.6-sol` with high thinking. Its model picker is
scoped to Sol (high), Terra (`max` in Pi, mapped to upstream `ultra` by
`files/home/.pi/agent/models.json`), Luna (high), and OpenCode Go models.

## Run

Add this function to `~/.zshrc` to create or resume a sandbox named after the
current directory:

```zsh
lambda() {
  local name="lambda-${PWD:t}"
  local kit="git+https://github.com/withlogicco/sbx-kit-lambda"
  local image="ghcr.io/withlogicco/sbx-kit-lambda:latest"

  # Only needed until CI publishes the image; see "Prebuilt image" below.
  # Requires a local clone, since the build needs the Dockerfile. The save/load
  # step is not optional: the sandbox runtime has its own image store and never
  # reads the host daemon's.
  if [[ "${1:-}" == "--build" ]]; then
    shift
    docker build -t "$image" /path/to/sbx-kit-lambda || return 1
    docker save "$image" -o "${TMPDIR:-/tmp}/lambda-image.tar" || return 1
    sbx template load "${TMPDIR:-/tmp}/lambda-image.tar" || return 1
    rm -f "${TMPDIR:-/tmp}/lambda-image.tar"
  fi

  if [[ "${1:-}" == "--reset" ]] && sbx ls --quiet | grep -Fxq -- "$name"; then
    sbx rm --force "$name"
  fi

  if sbx ls --quiet | grep -Fxq -- "$name"; then
    sbx run --name "$name"
  else
    sbx run --name "$name" --kit "$kit" lambda
  fi
}
```

Reload with `source ~/.zshrc`, then run `lambda`. Use `lambda --reset` to
recreate the current directory's sandbox after changing the kit or global
credentials.

Without the helper:

```bash
# Create and attach
sbx run --name lambda-my-project \
  --kit git+https://github.com/withlogicco/sbx-kit-lambda \
  lambda

# Reattach later
sbx run --name lambda-my-project
```

Loading the kit from GitHub requires the source to be allowlisted once:

```bash
sbx settings set kit.allowedSources '["docker.io/","github.com/withlogicco/"]'
```

## Persistent state

Volumes survive sandbox recreation:

| Path | Contents |
| ---- | -------- |
| `/home/agent/.pi/agent/sessions` | Pi session history |
| `/home/agent/.claude` | Claude Code credentials, settings, and session state |
| `/home/agent/.codex` | Codex CLI state |

`~/.pi/agent` as a whole is deliberately not persisted: the kit ships
`models.json` and its extensions into that directory, and a volume there would
shadow kit-owned files across kit updates. Pi's `auth.json` therefore does not
survive recreation, which does not matter because auth is host-managed rather
than stored in the sandbox.

Volumes are keyed to the sandbox name, so they are never shared between
sandboxes. That is why credentials are resolved from the host secret store
rather than kept in a volume — otherwise every project would need its own
logins.

## Installed tools

| Tool | Source |
| ---- | ------ |
| Pi (`pi`, `lambda`) | `pi.dev` installer |
| Codex CLI (`codex`) | npm `@openai/codex` |
| Claude Code (`claude`) | npm `@anthropic-ai/claude-code` |
| GitHub CLI (`gh`) | [Webi](https://webi.sh/gh), into `~/.local/bin` |

Webi is the default for standalone CLI tools. Pi, Codex, and Claude Code use
their upstream installers because Webi does not package them.

All four are installed by `files/home/.lambda/install-tools.sh`. Every step in
it is guarded and idempotent, so it is a no-op when the tools are already
present.

### Prebuilt image

`setup.install` runs that script on every sandbox creation, which costs roughly
60-90s. The repository's `Dockerfile` runs the *same* script on top of
`docker/sandbox-templates:shell-docker` so the tools land in cached layers
instead, and `sandbox.image` points at the resulting image.

`.github/workflows/image.yml` publishes `linux/amd64` and `linux/arm64` to
`ghcr.io/withlogicco/sbx-kit-lambda` on pushes to `main`, on tags, weekly, and
on manual dispatch. The image is public, so no registry credential is needed.

**Until that tag is published, build it locally — and hand the result to the
sandbox runtime.** The runtime keeps its own image store (`sbx template ls`)
and does not fall back to the host Docker daemon's, so an image that only
exists on the host still fails creation with `403 Forbidden: pull failed for
image ...`. Building is therefore two steps, not one:

```bash
docker build -t ghcr.io/withlogicco/sbx-kit-lambda:latest .
docker save ghcr.io/withlogicco/sbx-kit-lambda:latest -o /tmp/lambda-image.tar
sbx template load /tmp/lambda-image.tar
```

Once the tag is in that store, sbx uses it instead of pulling, so no spec change
is needed once CI takes over.

The `lambda --build` helper above does all of this for you. Rebuild after
changing the `Dockerfile` or `install-tools.sh` — and re-load, since the runtime
keeps serving the previously loaded layers otherwise. Note that a local build
masquerades as the GHCR tag, so `sbx template ls` (image ID and age) is the only
way to tell whether you are running a local build or the published one.

`spec.yaml` also declares `sandbox.build` pointing at the `Dockerfile`, so the
image's origin is discoverable from the spec. sbx does not act on it yet and
emits a notice saying the image is taken from `sandbox.image`; that notice is
expected. Declaring `build` *without* `image` is not possible — the kit fails
validation with `sandbox.build is accepted in the schema but not yet
implemented — specify sandbox.image`.

If you would rather not build anything, point `sandbox.image` back at
`docker/sandbox-templates:shell-docker`. The guarded script installs everything
at creation time instead.

## VS Code Remote SSH

One-time host setup:

```bash
sbx setup ssh
```

Connect VS Code's Remote - SSH extension to `<sandbox-name>.sbx`. The network
policy allows the VS Code server and extension gallery download hosts.

## Validation

```bash
sbx kit validate .
sbx kit inspect .
```

A clean local smoke sandbox:

```bash
sbx create --name lambda-v2-smoke --kit . lambda .
sbx run --name lambda-v2-smoke
```

Remove it afterwards with `sbx rm --force lambda-v2-smoke`.
