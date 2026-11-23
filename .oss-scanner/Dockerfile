# Build environment for Anthropic's OSS Scanner (https://red.anthropic.com/oss-scanner).
# It is not a deployment image: use the Dockerfile at the repository root for that.
#
# The scanner builds this file with the repository as build context and with
# network access, then analyses the image without any network. Everything the
# backend, the client and their tests need must therefore be installed here.
# The scanner removes the repository's .dockerignore before it builds, so
# `COPY . /src` brings the tests and the documentation along.
#
# What to run inside the image is described in threat_model.md next to this file.

# Same base image as the build stage of the root Dockerfile, so the native
# modules (better-sqlite3, bcrypt, pkcs11js) compile as they do for a release.
FROM node:26-trixie@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Husky would install the repository's Git hooks, which run the formatter and
# linter on every commit. The scanner commits its own patches, so leave them out.
ENV HUSKY=0
# The PostgreSQL, Vault and S3 suites start containers with Testcontainers.
# There is no container runtime inside this image, so skip them on purpose.
ENV E2E_SKIP_CONTAINERS=true

# Node 25 and later no longer bundle corepack, so install it before enabling it.
RUN npm install -g corepack@0.36.0 && corepack enable

# Scanner contract: the checkout lives inside the image, at /src.
COPY . /src
WORKDIR /src

# No cache mount here: the pnpm store has to stay in the image, so that
# `pnpm install --offline` still works after a patch.
RUN pnpm install --frozen-lockfile

# Everything except the documentation site: config format, SDK, backend, CLI
# and the web client, in dependency order.
RUN pnpm -r --filter '!@eudiplo/docs' build

# Chromium for the client's Playwright suites and for reproducing findings in
# the web client.
RUN pnpm --filter @eudiplo/client exec playwright install --with-deps chromium

# Run the backend unit tests once to show that the image works. A failing or
# slow test must not fail the build, because then nothing is scanned.
RUN timeout 900 pnpm --filter @eudiplo/backend exec vitest run \
    || echo "WARNING: the backend unit tests did not pass in this image"

CMD ["bash"]
