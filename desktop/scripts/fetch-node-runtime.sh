#!/usr/bin/env bash
# Fetch and cache a platform-matching Node.js binary for Tauri bundling.
# The binary is placed at src-tauri/resources/node/<os>-<arch>/node[.exe]
#
# Environment variables:
#   NODE_VERSION   e.g. 24.1.0 (default below)
#   FORCE_FETCH    set to 1 to re-download even if the binary already exists
#
# NOTE: fetch-node-runtime.js (used by tauri.conf beforeBuildCommand) is the
# canonical fetcher and the source of truth for the bundled Node version. Keep
# this default in sync with its DEFAULT_NODE_VERSION; the packed better-sqlite3
# ABI must match this runtime (enforced by scripts/pack-native.js).

set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-24.1.0}"
FORCE_FETCH="${FORCE_FETCH:-0}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin)
    PLATFORM="darwin"
    EXT="tar.gz"
    ;;
  linux)
    PLATFORM="linux"
    EXT="tar.xz"
    ;;
  msys*|cygwin*|mingw*)
    PLATFORM="win"
    EXT="zip"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)
    echo "Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

TARGET_DIR="src-tauri/resources/node/${PLATFORM}-${ARCH}"
BINARY_NAME="node"
[ "$PLATFORM" = "win" ] && BINARY_NAME="node.exe"
BINARY_PATH="$TARGET_DIR/$BINARY_NAME"

if [ -f "$BINARY_PATH" ] && [ "$FORCE_FETCH" != "1" ]; then
  echo "[fetch-node-runtime] cached $BINARY_PATH"
  exit 0
fi

BASE_NAME="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${BASE_NAME}.${EXT}"
TMP_DIR=".tmp-node-runtime"
ARCHIVE="$TMP_DIR/${BASE_NAME}.${EXT}"

mkdir -p "$TMP_DIR" "$TARGET_DIR"

echo "[fetch-node-runtime] downloading $URL"
curl -fsSL "$URL" -o "$ARCHIVE"

echo "[fetch-node-runtime] extracting $ARCHIVE"
if [ "$PLATFORM" = "win" ]; then
  unzip -q "$ARCHIVE" -d "$TMP_DIR"
  cp "$TMP_DIR/$BASE_NAME/node.exe" "$BINARY_PATH"
else
  tar -xf "$ARCHIVE" -C "$TMP_DIR"
  cp "$TMP_DIR/$BASE_NAME/bin/node" "$BINARY_PATH"
  chmod +x "$BINARY_PATH"
fi

rm -rf "$TMP_DIR"
echo "[fetch-node-runtime] ready $BINARY_PATH"
