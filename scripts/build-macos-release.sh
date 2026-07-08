#!/usr/bin/env bash
# 天枢 macOS 双架构打包脚本 (2.16.5)
# 用法: bash scripts/build-macos-release.sh
# 前提: Node 24+, Rust targets (aarch64 + x86_64), Tauri CLI
set -euo pipefail
cd "$(dirname "$0")/.."

VER="2.16.5"
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
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin npm run tauri:build -- --target aarch64-apple-darwin
cd ..

# 4. Tauri 构建 — x86_64 (Intel)
echo "=== 构建 x86_64 (Intel) ==="
cd desktop
TAURI_ENV_TARGET_TRIPLE=x86_64-apple-darwin npm run tauri:build -- --target x86_64-apple-darwin
cd ..

# 5. 收集产物
mkdir -p release
RELEASE_DIR="desktop/src-tauri/target/aarch64-apple-darwin/release/bundle"
cp "$RELEASE_DIR/macos/"*.app.tar.gz "release/Tianshu_${VER}_aarch64.app.tar.gz" 2>/dev/null || echo "⚠ aarch64 .app.tar.gz 未找到"
cp "$RELEASE_DIR/dmg/"*.dmg "release/Tianshu_${VER}_aarch64.dmg" 2>/dev/null || echo "⚠ aarch64 .dmg 未找到"

RELEASE_DIR_X64="desktop/src-tauri/target/x86_64-apple-darwin/release/bundle"
cp "$RELEASE_DIR_X64/macos/"*.app.tar.gz "release/Tianshu_${VER}_x64.app.tar.gz" 2>/dev/null || echo "⚠ x64 .app.tar.gz 未找到"
cp "$RELEASE_DIR_X64/dmg/"*.dmg "release/Tianshu_${VER}_x64.dmg" 2>/dev/null || echo "⚠ x64 .dmg 未找到"

echo ""
echo "=== 打包完成 ==="
ls -lh release/ 2>/dev/null || echo "release/ 目录为空"
echo "产物在: $(pwd)/release/"
