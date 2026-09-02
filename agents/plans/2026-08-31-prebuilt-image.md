# Prebuild the Lambda agent image

## Scope

Move tool installation out of `setup.install` and into a prebuilt image so
sandbox creation stops paying for the Pi installer and two npm installs every
time. Also record the Claude Code credential-source options.

## Relevant files

- `Dockerfile`
- `.dockerignore`
- `.github/workflows/image.yml`
- `spec.yaml`
- `README.md`
- `AGENTS.md`

## Implementation

1. Extract every tool install into `files/home/.lambda/install-tools.sh`,
   guarded and idempotent, running as the agent user.
2. Add a `Dockerfile` on `docker/sandbox-templates:shell-docker` that COPYs and
   runs that same script, with `HOME` set explicitly because a `USER` switch
   does not set it.
3. Replace the four tool-install commands in `setup.install` with a single call
   to the script.
4. Add `.github/workflows/image.yml` to build `linux/amd64` and `linux/arm64`
   and push to `ghcr.io/withlogicco/sbx-kit-lambda` on pushes to `main`, on
   tags, weekly, and on manual dispatch. Verify the agent-image contract and
   every expected binary against the pushed digest.
5. Point `sandbox.image` at `ghcr.io/withlogicco/sbx-kit-lambda:latest` and
   declare `sandbox.build` alongside it, and build that tag locally from the
   `lambda` shell helper until CI publishes it.

## Decisions

- **The kit cannot build its own image.** sbx accepts `sandbox.build` and then
  warns: "Dockerfile builds are accepted in the schema but not yet built by the
  runtime; the image is taken from sandbox.image". Declaring `build` *without*
  `image` is worse than useless — the kit fails validation outright with
  "sandbox.build is accepted in the schema but not yet implemented — specify
  sandbox.image".
- **`sandbox.build` is declared anyway, alongside `image`.** It buys no
  behavior, and costs one notice on every validate and inspect, but it makes the
  image's origin discoverable from the spec instead of only from a comment.
  Worth revisiting if sbx ever implements it: for a kit consumed over
  `git+https://`, honouring `build` would switch every user from pulling a
  cached multi-arch image to building locally on first create, which is slower
  and needs a working local Docker daemon. Pulling from GHCR is the better end
  state, not a stopgap.
- **One script, two consumers.** Tool installation lives only in
  `files/home/.lambda/install-tools.sh`. The Dockerfile bakes it and
  `setup.install` runs it, so there is no second list of installs to keep in
  sync. Static files under `files/home/` land before install commands, which is
  what makes this work.
- **`sandbox.image` uses the final GHCR tag from the start.** The sandbox
  runtime keeps its own image store and never reads the host Docker daemon, so a
  local build must be handed over with `docker save` followed by `sbx template
  load` before it satisfies the tag. `sbx template ls`, rather than `docker
  image inspect`, shows which image the runtime can use. The `lambda` shell
  helper builds, saves, and loads the image on demand with `--build`; CI
  publishing requires no spec change.
- **Public image on GHCR.** Avoids every user needing
  `sbx secret set --registry ghcr.io` before the kit can pull.
- **Floating tool versions, rebuilt weekly.** Pins would be reproducible but
  need constant bumping; the weekly rebuild plus the guarded `setup.install`
  fallback covers staleness. Revisit if a bad upstream release ever ships.
- **`setup.install` keeps calling the script even once the image is prebuilt.**
  It no-ops against an image that already has the tools, and it keeps the kit
  usable against a plain `shell-docker` base or if a pull fails.
- **`.dockerignore` admits only the `Dockerfile` and the `files/` tree.** The
  Dockerfile COPYs a single path from it, so the layer cache keys on that one
  script rather than on the rest of the kit.
- **`USER root` at the end of the Dockerfile.** sbx selects the user for the
  entrypoint and for every `setup.install` command explicitly — verified in the
  earlier smoke sandbox, where `sbx exec` ran as `agent` under a base image the
  kit had not modified — so the trailing `USER` does not decide what the agent
  runs as.

## Claude Code credential source

**Superseded by [the usage-based Anthropic authentication plan](2026-09-02-usage-based-anthropic-auth.md).**
The `claude setup-token` conclusion applied to the earlier native-Claude smoke
test (`isUsingOverage: false`) but not to the current shared credential design.
The kit now mints `claude-code` with `pi auth print-bearer-token --provider
anthropic` and injects that one bearer into both Pi and native Claude requests;
Anthropic use through this credential is usage-based. The proposed Keychain
command is not used.

## Verification

- `sbx kit validate .`.
- The workflow's own image-contract check.
- Create a sandbox once the image is published and confirm creation no longer
  runs the tool installs, and that Pi, Codex, Claude Code, and `gh` all work.

## Sequencing

`sandbox.image` names a tag that does not exist in GHCR until the workflow runs.
Two ways to get there:

- Build and hand over locally: `docker build -t
  ghcr.io/withlogicco/sbx-kit-lambda:latest .`, then `docker save` the tag and
  `sbx template load` the tarball, or just run the `lambda` helper, which does
  all three steps when invoked with `--build`.
- Publish from a branch with the workflow's `workflow_dispatch` trigger.

Either way, confirm with a smoke sandbox that creation no longer spends time on
the tool installs before relying on it.