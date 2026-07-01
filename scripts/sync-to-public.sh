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

echo "=== 同步: src/（排除测试文件）==="
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '__tests__/' \
  --exclude '*.test.ts' \
  --exclude '*.test.tsx' \
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

echo "=== 同步: desktop/（排除测试文件）==="
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude 'src-tauri/gen/' \
  --exclude '.DS_Store' \
  --exclude '__tests__/' \
  --exclude '*.test.ts' \
  --exclude '*.test.tsx' \
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

echo "=== 同步: 品牌资产（README 横幅/Logo 等图片）==="
if [[ -d "$DEV_DIR/docs/brand/assets" ]]; then
  mkdir -p "$PUB_DIR/docs/brand/assets"
  rsync $RSYNC_FLAGS "$DEV_DIR/docs/brand/assets/" "$PUB_DIR/docs/brand/assets/"
fi

echo "=== 同步: 英文 README ==="
# 主页 README.md 现为中文（见下方配置文件循环），英文版作为 README.en.md 同步。
if [[ -f "$DEV_DIR/README.en.md" ]]; then
  rsync $RSYNC_FLAGS "$DEV_DIR/README.en.md" "$PUB_DIR/README.en.md"
fi
# 清理：旧的独立中文页已并入主页 README.md，移除公开仓库里残留的 README.zh-CN.md。
if [[ "$DRY_RUN" != "--dry-run" && -f "$PUB_DIR/README.zh-CN.md" ]]; then
  rm -f "$PUB_DIR/README.zh-CN.md"
  echo "  已移除冗余 $PUB_DIR/README.zh-CN.md"
fi

echo "=== 同步: 发布文档 ==="
if [[ -f "$DEV_DIR/docs/publishing.md" ]]; then
  rsync $RSYNC_FLAGS "$DEV_DIR/docs/publishing.md" "$PUB_DIR/docs/publishing.md"
fi

echo "=== 同步: 配置文件（README.md 为中文主页）==="
for f in README.md CLAUDE.md .rivet.md AGENTS.md .rivet/SELF .rivet-config.json tsconfig.json tsup.config.ts package.json; do
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
