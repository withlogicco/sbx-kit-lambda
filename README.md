# lambda Pi Kit

This kit installs Pi behind the `codex` command inside Docker SBX's built-in
`codex` agent.
Using the built-in identity is intentional: SBX 0.35 associates the stored
OpenAI OAuth credential with the `codex` agent name. The launch command is
therefore:

```bash
sbx run --kit git+https://github.com/withlogicco/sbx-kit-lambda codex
```

The default `codex` command launches the lambda agent. The original SBX Codex CLI remains
available as `sbx-codex`:

```bash
codex
sbx-codex
```

Pi starts on `openai-codex/gpt-5.6-terra` with high thinking. Its model picker
is scoped to all Codex models and OpenCode Go models.

## Setup

Store OpenCode Go API key:

```bash
sbx secret set -g opencode-go
```

Authenticate with OpenAI:

```bash
sbx secret set -g openai --oauth
```

SBX retains the credential on the host and does not expose its value in the
sandbox.

## Run

Add this function to `~/.zshrc` to create or resume a sandbox named
`lambda-<current-directory>`:

```zsh
lambda() {
  local name="lambda-${PWD:t}"
  local kit="git+https://github.com/withlogicco/sbx-kit-lambda"

  if [[ "${1:-}" == "--reset" ]] && sbx ls --quiet | grep -Fxq -- "$name"; then
    sbx rm --force "$name"
  fi

  if sbx ls --quiet | grep -Fxq -- "$name"; then
    sbx run --name "$name"
  else
    sbx run --kit "$kit" --name "$name" codex
  fi
}
```

Reload your Zsh configuration with `source ~/.zshrc`, then run `lambda` from
the project directory. To remove the directory's existing sandbox and create a
fresh one, run `lambda --reset`.

```bash
sbx run --kit git+https://github.com/withlogicco/sbx-kit-lambda codex
```

Run lambda after the sandbox is created:

```bash
sbx run --kit git+https://github.com/withlogicco/sbx-kit-lambda --name <sandbox-name> codex
```

Validate the kit with:

```bash
sbx kit validate .
```
