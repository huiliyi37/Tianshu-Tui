#!/usr/bin/env bash
# 天枢 macOS 双架构打包脚本 (2.16.6)
# 用法: bash scripts/build-macos-release.sh
# 前提: Node 24+, Rust targets (aarch64 + x86_64), Tauri CLI
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
# --bundles app: skip DMG (hdiutil requires full macOS permissions outside agent sandbox)
echo "=== 构建 arm64 (Apple Silicon) ==="
cd desktop
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin npm run tauri:build -- --target aarch64-apple-darwin --bundles app
cd ..

# 4. Tauri 构建 — x86_64 (Intel)
echo "=== 构建 x86_64 (Intel) ==="
cd desktop
TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin npm run tauri:build -- --target x86_64-apple-darwin --bundles app
cd ..

# 5. 收集产物 — 从 .app bundle 创建 .tar.gz 归档
mkdir -p release
RELEASE_DIR="desktop/src-tauri/target/aarch64-apple-darwin/release/bundle"
if [ -d "$RELEASE_DIR/macos/Tianshu.app" ]; then
  echo "--- 归档 arm64 .app ---"
  tar -czf "release/Tianshu_${VER}_aarch64.app.tar.gz" -C "$RELEASE_DIR/macos" Tianshu.app
  echo "  ✅ release/Tianshu_${VER}_aarch64.app.tar.gz"
fi

RELEASE_DIR_X64="desktop/src-tauri/target/x86_64-apple-darwin/release/bundle"
if [ -d "$RELEASE_DIR_X64/macos/Tianshu.app" ]; then
  echo "--- 归档 x86_64 .app ---"
  tar -czf "release/Tianshu_${VER}_x64.app.tar.gz" -C "$RELEASE_DIR_X64/macos" Tianshu.app
  echo "  ✅ release/Tianshu_${VER}_x64.app.tar.gz"
fi

echo ""
echo "=== 打包完成 ==="
ls -lh release/ 2>/dev/null || echo "release/ 目录为空"
echo "产物在: $(pwd)/release/"
