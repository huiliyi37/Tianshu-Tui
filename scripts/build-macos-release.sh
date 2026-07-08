#!/usr/bin/env bash
# 天枢 macOS 双架构打包脚本 (2.17.3)
# 用法: bash scripts/build-macos-release.sh
# 前提: Node 24+, Rust targets (aarch64 + x86_64), Tauri CLI
#
# 终端直接运行：完整 DMG + .app.tar.gz
# agent 沙箱内运行：DMG 创建 (hdiutil) 会失败，脚本自动跳过并仅收集 .app.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

VER="2.17.3"
echo "=== 天枢 macOS 打包 v$VER ==="

# 1. 确保版本一致
node -e "
const r=require('./package.json'), d=require('./desktop/package.json');
if(r.version!=='$VER') throw new Error('root version mismatch: '+r.version);
if(d.version!=='$VER') throw new Error('desktop version mismatch: '+d.version);
console.log('版本校验通过: root='+r.version+' desktop='+d.version)
"

# 2. 构建 CLI (tsup) + 前端 (vite) + 原生二进制
echo "--- 构建 CLI ---"
npm run build
echo "--- 构建桌面前端 ---"
cd desktop && npm run build && cd ..
echo "--- 打包原生二进制 ---"
node scripts/pack-native.js

# 3. Tauri 构建 — arm64 (Apple Silicon)
echo "=== 构建 arm64 (Apple Silicon) ==="
cd desktop
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin npm run tauri:build -- --target aarch64-apple-darwin || echo "⚠ arm64 构建未完全成功（DMG 可能失败，.app 不受影响）"
cd ..

# 4. Tauri 构建 — x86_64 (Intel)
echo "=== 构建 x86_64 (Intel) ==="
cd desktop
TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin npm run tauri:build -- --target x86_64-apple-darwin || echo "⚠ x86_64 构建未完全成功（DMG 可能失败，.app 不受影响）"
cd ..

# 5. 收集产物 — DMG（Tauri 自动生成）和 .app.tar.gz
mkdir -p release

collect_arch() {
  local arch="$1"
  local bundle_dir="desktop/src-tauri/target/${arch}-apple-darwin/release/bundle"

  # DMG — Tauri 自动生成（终端环境有效，沙箱内 hdiutil 无权限会缺这个文件）
  for dmg in "$bundle_dir/dmg/"*.dmg; do
    if [ -f "$dmg" ]; then
      cp "$dmg" "release/Tianshu_${VER}_${arch}.dmg"
      echo "  ✅ release/Tianshu_${VER}_${arch}.dmg"
    fi
  done

  # .app.tar.gz — Tauri 自动生成，如果 Tauri 没生成就自己打包
  for tgz in "$bundle_dir/macos/"*.app.tar.gz; do
    if [ -f "$tgz" ]; then
      cp "$tgz" "release/Tianshu_${VER}_${arch}.app.tar.gz"
      echo "  ✅ release/Tianshu_${VER}_${arch}.app.tar.gz (from Tauri)"
    fi
  done

  # 兜底：Tauri 没生成 .app.tar.gz 但 .app 存在 → 自己打包
  if [ ! -f "release/Tianshu_${VER}_${arch}.app.tar.gz" ] && [ -d "$bundle_dir/macos/Tianshu.app" ]; then
    tar -czf "release/Tianshu_${VER}_${arch}.app.tar.gz" -C "$bundle_dir/macos" Tianshu.app 2>/dev/null
    if [ -f "release/Tianshu_${VER}_${arch}.app.tar.gz" ]; then
      echo "  ✅ release/Tianshu_${VER}_${arch}.app.tar.gz (self-packed)"
    fi
  fi
}

collect_arch "aarch64"
collect_arch "x86_64"

echo ""
echo "=== 打包完成 ==="
ls -lh release/ 2>/dev/null || echo "release/ 目录为空"
echo "产物在: $(pwd)/release/"
