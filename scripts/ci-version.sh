#!/usr/bin/env bash
# Prints the build version for a non-release build: <latest semver tag>-main.<short sha>.
# Used for main-branch Docker images and npm prereleases so both report the same version.
# Falls back to 0.0.0 when no tags are available (e.g. shallow clone).
set -euo pipefail

SOURCE_SHA="${1:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LATEST_TAG=$(git -C "$REPO_ROOT" tag --sort=-v:refname | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
CURRENT_VERSION="${LATEST_TAG#v}"
CURRENT_VERSION="${CURRENT_VERSION:-0.0.0}"

echo "${CURRENT_VERSION}-main.${SOURCE_SHA:0:7}"
