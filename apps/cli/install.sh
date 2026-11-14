#!/usr/bin/env bash
set -euo pipefail

REPO="EUDIPLO/eudiplo"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
INSTALL_DIR="${EUDIPLO_INSTALL_DIR:-$HOME/.local/bin}"

TAG=""
ASSET=""
OS=""
ARCH=""

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

ensure_npm_fallback() {
  command -v npm >/dev/null 2>&1 || fail "npm is required for the fallback install on this platform"
}

resolve_latest_tag() {
  TAG="$(curl -fsSL "$GITHUB_API" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  [[ -n "$TAG" ]] || fail "Could not resolve the latest EUDIPLO release tag. Install the npm package instead: npm install -g @eudiplo/cli"
}

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)
      case "$ARCH" in
        x86_64|amd64)
          ASSET="eudiplo-${TAG}-linux-x64.tar.gz"
          ;;
        arm64|aarch64)
          ASSET="eudiplo-${TAG}-linux-arm64.tar.gz"
          ;;
        *)
          fallback_to_npm_install "Standalone CLI builds are not published for Linux architecture ${ARCH}."
          ;;
      esac
      ;;
    Darwin)
      case "$ARCH" in
        arm64|aarch64)
          ASSET="eudiplo-${TAG}-macos-arm64.tar.gz"
          ;;
        *)
          fallback_to_npm_install "Standalone CLI builds are not published for macOS architecture ${ARCH}."
          ;;
      esac
      ;;
    *)
      fail "Unsupported operating system: ${OS}. This installer supports Linux and macOS. For Windows, use npm (npx @eudiplo/cli demo) or the Windows x64 release archive."
      ;;
  esac
}

get_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi

  fail "No SHA-256 tool found. Install sha256sum (Linux) or shasum (macOS)."
}

fallback_to_npm_install() {
  local reason="$1"
  echo "$reason"
  echo "Falling back to the npm package install."
  ensure_npm_fallback
  npm install -g "@eudiplo/cli@${TAG#v}"
  echo "Installed @eudiplo/cli via npm"
  exit 0
}

verify_archive_checksum() {
  local archive_file="$1"
  local checksums_file="$2"
  local expected actual

  expected="$(awk -v filename="$ASSET" '$2 == filename || $2 == "*" filename || $2 ~ ("/" filename "$") { print $1; exit }' "$checksums_file")"
  [[ -n "$expected" ]] || fail "Checksum entry for ${ASSET} was not found in SHA256SUMS.txt"

  actual="$(get_sha256 "$archive_file")"
  [[ -n "$actual" ]] || fail "Failed to calculate SHA-256 checksum for ${ASSET}"

  if [[ "$expected" != "$actual" ]]; then
    fail "Checksum verification failed for ${ASSET}. Expected ${expected}, got ${actual}."
  fi
}

main() {
  require_tool curl
  require_tool tar

  local install_path download_url checksums_url archive_file checksums_file archive_dir

  resolve_latest_tag
  detect_platform

  download_url="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
  checksums_url="https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS.txt"
  install_path="${INSTALL_DIR}/eudiplo"

  mkdir -p "${INSTALL_DIR}"

  archive_file="$(mktemp "${TMPDIR:-/tmp}/eudiplo-install.XXXXXX")"
  checksums_file="$(mktemp "${TMPDIR:-/tmp}/eudiplo-sha256.XXXXXX")"
  archive_dir="$(mktemp -d "${TMPDIR:-/tmp}/eudiplo-archive.XXXXXX")"
  trap 'rm -f "${archive_file:-}" "${checksums_file:-}"; rm -rf "${archive_dir:-}"' EXIT

  echo "Downloading ${ASSET} from ${download_url}"
  curl -fsSL "$download_url" -o "$archive_file" || fail "Failed to download release archive ${ASSET} from ${download_url}"

  echo "Downloading SHA256SUMS.txt from ${checksums_url}"
  curl -fsSL "$checksums_url" -o "$checksums_file" || fail "Failed to download SHA256SUMS.txt from ${checksums_url}"

  echo "Verifying checksum for ${ASSET}"
  verify_archive_checksum "$archive_file" "$checksums_file"

  tar -xzf "$archive_file" -C "$archive_dir" || fail "Failed to extract ${ASSET}."
  [[ -x "$archive_dir/eudiplo" ]] || fail "Release archive ${ASSET} did not contain an executable eudiplo binary"
  install -m 755 "$archive_dir/eudiplo" "$install_path"
  echo "Installed EUDIPLO CLI to: ${install_path}"

  if [[ ":${PATH}:" != *":${INSTALL_DIR}:"* ]]; then
    echo "Add this to your shell profile if needed:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  echo "Run: eudiplo --help"
}

main "$@"
