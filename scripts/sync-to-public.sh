#!/usr/bin/env bash
# sync-to-public.sh — 从开发仓库同步到开源仓库
#
# 用法: bash scripts/sync-to-public.sh [--dry-run]
#
# 同步策略:
#   ✅ 同步: src/ desktop/ docs/seed-capsule*.md docs/seed-capsule-archive/
#            docs/stars/ scripts/ CLAUDE.md .rivet/knowledge/
#            .github/workflows/build-windows.yml
#   ❌ 不同步: docs/design/ docs/teamtask/ docs/superpowers/
#             .rivet/plans/ .rivet/sessions/ .rivet/backups/
#             .rivet/constellation.json .rivet/vsw/ .cursor/

set -euo pipefail

DEV_DIR="/Users/banxia/app/deepseek-tui/opencode-tui"
PUB_DIR="/Users/banxia/app/Tianshu"
DRY_RUN="${1:-}"

RSYNC_FLAGS="-av --delete"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  RSYNC_FLAGS="-avn --delete"
  echo "[dry-run] 不实际写入，只显示将要同步的内容"
fi

echo "=== 同步: src/ ==="
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  "$DEV_DIR/src/" "$PUB_DIR/src/"

echo "=== 同步: scripts/ ==="
rsync $RSYNC_FLAGS \
  --exclude='sync-to-public.sh' \
  --exclude='glm-diag.ts' \
  --exclude='mimo-diag.ts' \
  --exclude='r-e2e.md' \
  --exclude='r-e2e.mjs' \
  --exclude='refactor-loop.ts' \
  --exclude='refactor-loop-task45.ts' \
  --exclude='verify-cache-hit-rate.ts' \
  --exclude='verify-task-a-multi-tool.ts' \
  --exclude='verify-task-b-session-state.ts' \
  --exclude='verify-task-c-fresh-boundary.ts' \
  --exclude='verify-native.sh' \
  --exclude='test-deepseek.ts' \
  --exclude='test-incremental.ts' \
  "$DEV_DIR/scripts/" "$PUB_DIR/scripts/"

echo "=== 同步: desktop/ ==="
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude 'src-tauri/gen/' \
  --exclude '.DS_Store' \
  "$DEV_DIR/desktop/" "$PUB_DIR/desktop/"

echo "=== 同步: 胶囊 ==="
rsync $RSYNC_FLAGS \
  "$DEV_DIR/docs/seed-capsule-"*.md "$PUB_DIR/docs/"
rsync $RSYNC_FLAGS \
  -r "$DEV_DIR/docs/seed-capsule-archive/" "$PUB_DIR/docs/seed-capsule-archive/"
rsync $RSYNC_FLAGS \
  -r "$DEV_DIR/docs/stars/" "$PUB_DIR/docs/stars/"

echo "=== 同步: .rivet/knowledge/ ==="
rsync $RSYNC_FLAGS \
  "$DEV_DIR/.rivet/knowledge/" "$PUB_DIR/.rivet/knowledge/"

echo "=== 同步: 配置文件 ==="
for f in README.md CLAUDE.md .rivet.md AGENTS.md .rivet/SELF .rivet-config.json tsconfig.json package.json; do
  if [[ -f "$DEV_DIR/$f" ]]; then
    rsync $RSYNC_FLAGS "$DEV_DIR/$f" "$PUB_DIR/$f"
  fi
done

echo "=== 同步: CI ==="
if [[ -f "$DEV_DIR/.github/workflows/build-windows.yml" ]]; then
  mkdir -p "$PUB_DIR/.github/workflows"
  rsync $RSYNC_FLAGS "$DEV_DIR/.github/workflows/build-windows.yml" "$PUB_DIR/.github/workflows/"
fi

echo ""
echo "=== 同步完成 ==="
echo "下一步: cd $PUB_DIR && git add -A && git diff --cached --stat"
if [[ "$DRY_RUN" != "--dry-run" ]]; then
  echo "确认无误后: cd $PUB_DIR && git commit -m 'sync: from dev repo' && git push"
fi
