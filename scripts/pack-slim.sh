#!/usr/bin/env bash
# 打包内测精简包 → /tmp/opencode-tui-slim.tar.gz
# 用法: bash scripts/pack-slim.sh

set -euo pipefail
cd "$(dirname "$0")/.."

tar czf /tmp/opencode-tui-slim.tar.gz \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./coverage' \
  --exclude='./build' \
  --exclude='./.rivet' \
  --exclude='./.rivet.md' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  --exclude='*.db-*' \
  --exclude='*.jsonl' \
  --exclude='./.tmp_*' \
  --exclude='./.claude' \
  --exclude='./.code-review-graph' \
  --exclude='./.git' \
  --exclude='./.github' \
  --exclude='./.omc' \
  --exclude='./.omx' \
  --exclude='./.superpowers' \
  --exclude='./.test-tmp' \
  --exclude='./.wolf' \
  --exclude='./.DS_Store' \
  --exclude='./.env' \
  --exclude='./.envrc' \
  \
  --exclude='./docs/analysis' \
  --exclude='./docs/archive' \
  --exclude='./docs/cache-baseline' \
  --exclude='./docs/changelog' \
  --exclude='./docs/design' \
  --exclude='./docs/known-issues' \
  --exclude='./docs/prompt-changelog' \
  --exclude='./docs/releases' \
  --exclude='./docs/research' \
  --exclude='./docs/teamtask' \
  --exclude='./docs/reviews' \
  --exclude='./docs/sessions' \
  --exclude='./docs/stars' \
  --exclude='./docs/tasks' \
  --exclude='./docs/superpowers' \
  --exclude='./docs/截图' \
  \
  --exclude='./docs/AB测试期间损失审计.md' \
  --exclude='./docs/BRANCH-STRATEGY.md' \
  --exclude='./docs/CVM运行时对Agent模型的实证影响.md' \
  --exclude='./docs/architecture-overview.md' \
  --exclude='./docs/architecture-subagent.md' \
  --exclude='./docs/cliproxy-fork-optimization.md' \
  --exclude='./docs/codebase-index.md' \
  --exclude='./docs/codex-cliproxy-account-pool.md' \
  --exclude='./docs/ctcl-claude-tool-compatibility-layer.md' \
  --exclude='./docs/ctcl思想.rtf' \
  --exclude='./docs/optimization-design-v2.md' \
  --exclude='./docs/optimization-design-v3.md' \
  --exclude='./docs/meridian-architecture.md' \
  --exclude='./docs/harness-engineering-resume.md' \
  --exclude='./docs/deepseek-v4-pro-to-model-team.md' \
  --exclude='./docs/天枢-vs-MiMoCode-vs-ClaudeCode-三维对标.md' \
  --exclude='./docs/简历-天枢项目经历.md' \
  --exclude='./docs/缓存phase 5前收束阶段 的测试验证.md' \
  --exclude='./docs/slash命令系统审查-T9迁移回归审计.md' \
  --exclude='./docs/tui-polish-todo.md' \
  --exclude='./docs/tui-repetition-analysis.md' \
  --exclude='./docs/debug-thinking-trace.md' \
  --exclude='./docs/debug调试日志开关.md' \
  --exclude='./docs/ARCHITECTURE-天枢全景.md' \
  --exclude='./docs/OPENCLAW-对比分析.md' \
  \
  --exclude='./teamtask' \
  --exclude='./截图' \
  --exclude='./star.md' \
  --exclude='./task_plan.md' \
  --exclude='./_doc-cvm.md' \
  --exclude='./_doc-project-resume.md' \
  --exclude='./_tianquan-capsule.md' \
  --exclude='./nul' \
  --exclude='./openclaw.json' \
  --exclude='./opencode.json' \
  --exclude='./tsconfig.tsbuildinfo' \
  . 2>/dev/null

echo "✅ /tmp/opencode-tui-slim.tar.gz"
ls -lh /tmp/opencode-tui-slim.tar.gz
echo ""
echo "归档内容（非 src/）："
tar tzf /tmp/opencode-tui-slim.tar.gz | grep -v '^\./src/' | sort
