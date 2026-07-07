#!/usr/bin/env bash
# sync-to-public.sh — 从开发仓库同步到开源仓库
#
# 用法: bash scripts/sync-to-public.sh [--dry-run]
#
# 同步策略(2026-07-07 起改为「默认公开 + 排除清单」):
#   ✅ 同步: src/(含测试)desktop/(含测试)scripts/ docs/ runtime-assets/
#            .rivet/knowledge/ .github/ patches/ completions/ prompts/
#            根配置与社区文件(README/LICENSE/SECURITY/CONTRIBUTING…)
#   ❌ 排除: 核心设计文档(docs/design、teamtask、superpowers、tasks、
#            research、analysis、reviews、sessions、archive、known-issues)、
#            个人/内部文件(简历、账号池、交接记录等)、本地运行数据
#
# 测试文件自 2026-07-07 起随源码公开——README 的测试指标必须可验证,
# 公开仓库 CI 的 npm test / windows-smoke 也依赖它们。

set -euo pipefail

DEV_DIR="/Users/banxia/app/deepseek-tui/opencode-tui"
PUB_DIR="/Users/banxia/app/Tianshu"
DRY_RUN="${1:-}"

RSYNC_FLAGS="-av --delete"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  RSYNC_FLAGS="-avn --delete"
  echo "[dry-run] 不实际写入，只显示将要同步的内容"
fi

echo "=== 同步: src/（含测试）==="
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  "$DEV_DIR/src/" "$PUB_DIR/src/"

echo "=== 同步: scripts/ ==="
rsync $RSYNC_FLAGS \
  --exclude='sync-to-public.sh' \
  "$DEV_DIR/scripts/" "$PUB_DIR/scripts/"

echo "=== 同步: desktop/（含测试）==="
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude 'src-tauri/gen/' \
  --exclude '.DS_Store' \
  "$DEV_DIR/desktop/" "$PUB_DIR/desktop/"

echo "=== 同步: docs/（排除核心设计文档与内部文件）==="
rsync $RSYNC_FLAGS \
  --exclude='design/' \
  --exclude='teamtask/' \
  --exclude='superpowers/' \
  --exclude='tasks/' \
  --exclude='research/' \
  --exclude='analysis/' \
  --exclude='reviews/' \
  --exclude='sessions/' \
  --exclude='archive/' \
  --exclude='known-issues/' \
  --exclude='cache-baseline/' \
  --exclude='简历-天枢项目经历.md' \
  --exclude='harness-engineering-resume.md' \
  --exclude='deepseek-v4-pro-to-model-team.md' \
  --exclude='codex-cliproxy-account-pool.md' \
  --exclude='cliproxy-fork-optimization.md' \
  --exclude='ctcl思想.rtf' \
  --exclude='*.rej' \
  --exclude='AB测试期间损失审计.md' \
  --exclude='handoff-goal-interrupt-issue.md' \
  --exclude='TODO-tianxuan-ccr-router.md' \
  --exclude='SESSION-MR0AZIEL-DIAGNOSIS.md' \
  --exclude='optimization-design-v2.md' \
  --exclude='desktop-planning-methodology.md' \
  --exclude='.DS_Store' \
  "$DEV_DIR/docs/" "$PUB_DIR/docs/"

echo "=== 同步: runtime-assets/（内置 skill，随 dist 打包）==="
# tsup publicDir 把 runtime-assets/bundled-skills → dist/bundled-skills，desktop 通过
# tauri resources 的 ../../dist 整包带走。缺了它 npm run build 的硬闸门会 exit(1)，
# 公开仓库/Windows CI 直接构建失败。必须同步。
rsync $RSYNC_FLAGS \
  --exclude 'node_modules/' \
  "$DEV_DIR/runtime-assets/" "$PUB_DIR/runtime-assets/"

echo "=== 同步: .rivet/knowledge/（排除本地专属记录）==="
rsync $RSYNC_FLAGS \
  --exclude='debug-windows-cmd-chcp-nul.md' \
  "$DEV_DIR/.rivet/knowledge/" "$PUB_DIR/.rivet/knowledge/"

echo "=== 同步: 英文 README ==="
if [[ -f "$DEV_DIR/README.en.md" ]]; then
  rsync $RSYNC_FLAGS "$DEV_DIR/README.en.md" "$PUB_DIR/README.en.md"
fi

echo "=== 同步: 构建依赖（补丁 / CLI 补全 / 工具提示模板）==="
for d in patches completions prompts; do
  if [[ -d "$DEV_DIR/$d" ]]; then
    rsync $RSYNC_FLAGS "$DEV_DIR/$d/" "$PUB_DIR/$d/"
  fi
done

echo "=== 同步: 根配置与社区文件（README.md 为中文主页）==="
# package-lock.json / .npmrc（engine-strict）：可复现安装的硬前提。
for f in README.md CLAUDE.md .rivet.md AGENTS.md .rivet/SELF .rivet-config.json \
         tsconfig.json tsup.config.ts package.json package-lock.json .npmrc \
         CHANGELOG.md LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md config.example.json; do
  if [[ -f "$DEV_DIR/$f" ]]; then
    rsync $RSYNC_FLAGS "$DEV_DIR/$f" "$PUB_DIR/$f"
  fi
done

echo "=== 同步: CI 与 issue 模板（.github，排除 dependabot）==="
if [[ -d "$DEV_DIR/.github" ]]; then
  rsync $RSYNC_FLAGS \
    --exclude='dependabot.yml' \
    "$DEV_DIR/.github/" "$PUB_DIR/.github/"
fi

echo "=== 清理: 公开仓库残留文件 ==="
if [[ "$DRY_RUN" != "--dry-run" ]]; then
  for stale in README.zh-CN.md findings.md progress.md task_plan.md; do
    if [[ -f "$PUB_DIR/$stale" ]]; then
      rm -f "$PUB_DIR/$stale"
      echo "  已移除残留 $PUB_DIR/$stale"
    fi
  done
fi

echo ""
echo "=== 同步完成 ==="
echo "下一步: cd $PUB_DIR && git add -A && git diff --cached --stat"
if [[ "$DRY_RUN" != "--dry-run" ]]; then
  echo "确认无误后: cd $PUB_DIR && git commit -m 'sync: from dev repo' && git push"
fi
