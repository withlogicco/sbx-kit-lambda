# syntax=docker/dockerfile:1

# Prebuilt Lambda agent image.
#
# The kit works without this image: `setup.install` runs the same
# install-tools.sh on a plain shell-docker base. But install commands run on
# every sandbox creation, and the Pi installer plus two npm installs and a Webi
# fetch cost roughly 60-90s each time. Baking them into cached layers makes
# creation near-instant.
#
# The kit cannot build this itself. sbx accepts `sandbox.build` but does not act
# on it — "the image is taken from sandbox.image" — so this is built by
# .github/workflows/image.yml and referenced by tag.
#
# shell-docker is the base Docker recommends for custom agents: it already
# provides the agent-image contract (non-root `agent` at UID 1000, passwordless
# sudo, /home/agent owned by agent, and proxy env vars preserved across sudo).
FROM docker/sandbox-templates:shell-docker

# Install as the agent user. HOME is set explicitly because a USER switch does
# not set it, and both the Pi installer and npm need it.
USER 1000
ENV HOME=/home/agent

# The same script the kit runs from setup.install, so tool installation has a
# single source of truth. COPYing only this path means unrelated kit edits do
# not bust the build cache. COPY writes as root:root by default, and /tmp is
# sticky, so the agent user could not remove the file afterwards without the
# explicit ownership; --chmod pins the exec bit regardless of the source mode.
COPY --chown=1000:1000 --chmod=0755 files/home/.lambda/install-tools.sh /tmp/install-tools.sh
RUN sh /tmp/install-tools.sh \
    && rm -f /tmp/install-tools.sh \
    && rm -rf "$HOME/.npm"

# Restore the conventional base state. sbx selects the user for the entrypoint
# and for every setup.install command explicitly — verified in a smoke sandbox,
# where `sbx exec` ran as `agent` under an unmodified base image — so this does
# not decide what the agent runs as.
USER root
