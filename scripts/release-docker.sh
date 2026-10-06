#!/usr/bin/env bash
set -euo pipefail

: "${DOCKER_REGISTRY_USER:?DOCKER_REGISTRY_USER is required}"
: "${DOCKER_REGISTRY_PASSWORD:?DOCKER_REGISTRY_PASSWORD is required}"
: "${DOCKER_RELEASE_VERSION:?DOCKER_RELEASE_VERSION is required}"
DOCKER_SOURCE_SHA="${DOCKER_SOURCE_SHA:-${GITHUB_SHA:-}}"
: "${DOCKER_SOURCE_SHA:?DOCKER_SOURCE_SHA (or GITHUB_SHA) is required}"

REGISTRY="ghcr.io/eudiplo"
DOCKERFILE="Dockerfile.release"
SOURCE_TAG="sha-${DOCKER_SOURCE_SHA}"

IFS='.' read -r MAJOR MINOR PATCH <<< "${DOCKER_RELEASE_VERSION}"

log() { printf "[release] %s\n" "$*"; }

login() {
  log "Logging in to GHCR..."
  echo "${DOCKER_REGISTRY_PASSWORD}" |
    docker login ghcr.io -u "${DOCKER_REGISTRY_USER}" --password-stdin
}

promote_image() {
  local image="$1"
  local image_base="${REGISTRY}/${image}"
  local source_image="${image_base}:${SOURCE_TAG}"
  local source_digest

  log "Promoting ${source_image} to release ${DOCKER_RELEASE_VERSION}"

  # A commit-specific tag can still be moved. Resolve the multi-platform manifest
  # once and use its digest for the build so the source cannot change mid-release.
  source_digest=$(docker buildx imagetools inspect "${source_image}" --format '{{json .Manifest}}' | jq -er '.digest')
  if [[ ! "$source_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    log "Invalid source digest for ${source_image}: ${source_digest}"
    return 1
  fi
  source_image="${image_base}@${source_digest}"
  log "Using immutable source ${source_image}"

  docker buildx build \
    --file "${DOCKERFILE}" \
    --platform linux/amd64,linux/arm64 \
    --build-arg SOURCE_IMAGE="${source_image}" \
    --build-arg VERSION="${DOCKER_RELEASE_VERSION}" \
    --tag "${image_base}:latest" \
    --tag "${image_base}:${DOCKER_RELEASE_VERSION}" \
    --tag "${image_base}:${MAJOR}" \
    --tag "${image_base}:${MAJOR}.${MINOR}" \
    --push \
    .
}

main() {
  login
  promote_image "eudiplo"
  promote_image "eudiplo-client"
  log "Done."
}

main "$@"
