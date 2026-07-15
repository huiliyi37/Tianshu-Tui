#!/usr/bin/env bash
# 天枢 macOS 双架构打包脚本 (2.18.0)
# 用法: bash scripts/build-macos-release.sh
# 前提: Node 24+, Rust targets (aarch64 + x86_64), Tauri CLI
#
# 终端直接运行：完整 DMG + .app.tar.gz
# agent 沙箱内运行：DMG 创建 (hdiutil) 会失败，脚本自动跳过并仅收集 .app.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

VER="2.19.2"
echo "=== 天枢 macOS 打包 v$VER ==="

# 1. 确保版本一致（桌面端 app 版本以 tauri.conf.json 为准，Cargo.toml 需同步）
node -e "
const r=require('./package.json'), d=require('./desktop/package.json');
const tc=require('./desktop/src-tauri/tauri.conf.json');
const cp=require('child_process');
const cargo = require('fs').readFileSync('./desktop/src-tauri/Cargo.toml','utf8');
const cargoVer = cargo.match(/^version\\s*=\\s*['\"]([^'\"]+)['\"]/m)?.[1];
if(r.version!=='$VER') throw new Error('root version mismatch: '+r.version);
if(d.version!=='$VER') throw new Error('desktop version mismatch: '+d.version);
if(tc.version!=='$VER') throw new Error('tauri.conf.json version mismatch: '+tc.version);
if(cargoVer!=='$VER') throw new Error('Cargo.toml version mismatch: '+cargoVer);
console.log('版本校验通过: root='+r.version+' desktop='+d.version+' tauri='+tc.version+' cargo='+cargoVer)
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

  # .app.tar.gz + .sig — Tauri 自动生成；.sig 是 updater 校验必需
  for tgz in "$bundle_dir/macos/"*.app.tar.gz; do
    if [ -f "$tgz" ]; then
      cp "$tgz" "release/Tianshu_${VER}_${arch}.app.tar.gz"
      echo "  ✅ release/Tianshu_${VER}_${arch}.app.tar.gz (from Tauri)"
      if [ -f "$tgz.sig" ]; then
        cp "$tgz.sig" "release/Tianshu_${VER}_${arch}.app.tar.gz.sig"
        echo "  ✅ release/Tianshu_${VER}_${arch}.app.tar.gz.sig"
      else
        echo "  ⚠️ 缺少 .sig 签名文件，自动更新将失败（检查 TAURI_SIGNING_PRIVATE_KEY）" >&2
      fi
    fi
  done

  # 兜底：Tauri 没生成 .app.tar.gz 但 .app 存在 → 自己打包（无签名，仅本地测试）
  if [ ! -f "release/Tianshu_${VER}_${arch}.app.tar.gz" ] && [ -d "$bundle_dir/macos/Tianshu.app" ]; then
    tar -czf "release/Tianshu_${VER}_${arch}.app.tar.gz" -C "$bundle_dir/macos" Tianshu.app 2>/dev/null
    if [ -f "release/Tianshu_${VER}_${arch}.app.tar.gz" ]; then
      echo "  ✅ release/Tianshu_${VER}_${arch}.app.tar.gz (self-packed, no signature)"
    fi
  fi
}

collect_arch "aarch64"
collect_arch "x86_64"

# 6. 更新 release/latest.json 的 darwin 条目，保留已有 windows 条目
node -e "
const fs = require('fs');
const manifestPath = 'release/latest.json';
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { version: '$VER', notes: '', pub_date: new Date().toISOString(), platforms: {} };
manifest.version = '$VER';
function addDarwin(arch, label) {
  const tgz = 'release/Tianshu_${VER}_' + label + '.app.tar.gz';
  const sig = tgz + '.sig';
  if (!fs.existsSync(tgz)) return;
  if (!fs.existsSync(sig)) throw new Error('缺少 ' + sig + '，无法生成 updater manifest');
  manifest.platforms['darwin-' + arch] = {
    url: 'https://github.com/huiliyi37/Tianshu-Tui/releases/download/v$VER/Tianshu_${VER}_' + label + '.app.tar.gz',
    signature: fs.readFileSync(sig, 'utf8').trim(),
  };
  console.log('  ✅ 更新 release/latest.json darwin-' + arch + ' 条目');
}
addDarwin('aarch64', 'aarch64');
addDarwin('x86_64', 'x64');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
"

echo ""
echo "=== 打包完成 ==="
ls -lh release/ 2>/dev/null || echo "release/ 目录为空"
echo "产物在: $(pwd)/release/"
