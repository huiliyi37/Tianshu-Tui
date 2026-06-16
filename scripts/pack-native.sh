#!/usr/bin/env bash
# Pack better-sqlite3 native binary into dist/native/
# Called after `npm run build` and before `tauri:build`.
#
# Idempotent: safe to run multiple times. Skips silently (exit 0) if
# better-sqlite3 is not installed — the nullDb fallback handles it.

set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
TARGET_DIR="dist/native"
TARGET="$TARGET_DIR/better_sqlite3.node"

if [ ! -f "$SOURCE" ]; then
  echo "⚠ pack-native: better-sqlite3 native binary not found at $SOURCE — skipping" >&2
  exit 0
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE" "$TARGET"

SIZE=$(du -h "$TARGET" | cut -f1)
echo "✅ Packed better-sqlite3.node ($SIZE) → $TARGET"
