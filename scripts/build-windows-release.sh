#!/usr/bin/env bash
# 天枢 Windows 打包脚本
# 用法: bash scripts/build-windows-release.sh
# 前提: Node 24+, Windows 版 Tauri CLI, NSIS, WiX（MSI）, Rust x86_64-pc-windows-msvc target
# 环境: 需在 Windows 宿主、Git Bash 或 WSL2 中运行，并设置 TAURI_SIGNING_PRIVATE_KEY
#
# 产物:
#   release/Tianshu_<VER>_x64-setup.exe
#   release/Tianshu_<VER>_x64-setup.exe.sig
#   release/latest.json（仅更新 windows-x86_64 条目，保留 macOS 条目）
set -euo pipefail
cd "$(dirname "$0")/.."

VER="2.19.2"
echo "=== 天枢 Windows 打包 v$VER ==="

# 1. 确保版本一致（桌面端 app 版本以 tauri.conf.json 为准，Cargo.toml 需同步）
node -e "
const r=require('./package.json'), d=require('./desktop/package.json');
const tc=require('./desktop/src-tauri/tauri.conf.json');
const cargo = require('fs').readFileSync('./desktop/src-tauri/Cargo.toml','utf8');
const cargoVer = cargo.match(/^version\\s*=\\s*['\"]([^'\"]+)['\"]/m)?.[1];
if(r.version!=='$VER') throw new Error('root version mismatch: '+r.version);
if(d.version!=='$VER') throw new Error('desktop version mismatch: '+d.version);
if(tc.version!=='$VER') throw new Error('tauri.conf.json version mismatch: '+tc.version);
if(cargoVer!=='$VER') throw new Error('Cargo.toml version mismatch: '+cargoVer);
console.log('版本校验通过: root='+r.version+' desktop='+d.version+' tauri='+tc.version+' cargo='+cargoVer)
"

# 2. 签名私钥闸门
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "✗ 未设置 TAURI_SIGNING_PRIVATE_KEY。Windows 自动更新必须带签名。" >&2
  echo "  参考 desktop/scripts/sign-and-build.sh 说明配置私钥。" >&2
  exit 1
fi
: "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:=}"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# 3. 构建 CLI (tsup) + 前端 (vite) + 原生二进制
echo "--- 构建 CLI ---"
npm run build
echo "--- 构建桌面前端 ---"
cd desktop && npm run build && cd ..
echo "--- 打包原生二进制 ---"
node scripts/pack-native.js

# 4. Tauri 构建 — Windows x86_64（NSIS + MSI）
echo "=== 构建 Windows x86_64 ==="
cd desktop
npm run tauri:build -- --target x86_64-pc-windows-msvc
cd ..

# 5. 收集产物
mkdir -p release
BUNDLE_DIR="desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
NSIS_DIR="$BUNDLE_DIR/nsis"
MSI_DIR="$BUNDLE_DIR/msi"

SETUP="Tianshu_${VER}_x64-setup.exe"
SETUP_SIG="${SETUP}.sig"

if [[ ! -f "$NSIS_DIR/$SETUP" ]]; then
  echo "✗ 未找到 NSIS 安装包: $NSIS_DIR/$SETUP" >&2
  exit 1
fi
if [[ ! -f "$NSIS_DIR/$SETUP_SIG" ]]; then
  echo "✗ 未找到 NSIS 签名文件: $NSIS_DIR/$SETUP_SIG（检查 TAURI_SIGNING_PRIVATE_KEY 是否正确）" >&2
  exit 1
fi

cp "$NSIS_DIR/$SETUP" "release/$SETUP"
cp "$NSIS_DIR/$SETUP_SIG" "release/$SETUP_SIG"
echo "  ✅ release/$SETUP"
echo "  ✅ release/$SETUP_SIG"

# MSI 仅用于首次手动分发，updater 不走它；存在就顺带收集
MSI_PATTERN="Tianshu_${VER}_x64_*.msi"
for msi in "$MSI_DIR"/$MSI_PATTERN; do
  if [[ -f "$msi" ]]; then
    cp "$msi" "release/$(basename "$msi")"
    echo "  ✅ release/$(basename "$msi")"
  fi
done

# 6. 更新 release/latest.json 的 windows-x86_64 条目，保留已有 macOS 条目
node -e "
const fs = require('fs');
const path = 'release/$SETUP_SIG';
const sig = fs.readFileSync(path, 'utf8').trim();
const manifestPath = 'release/latest.json';
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { version: '$VER', notes: '', pub_date: new Date().toISOString(), platforms: {} };
manifest.version = '$VER';
manifest.platforms['windows-x86_64'] = {
  url: 'https://github.com/huiliyi37/Tianshu-Tui/releases/download/v$VER/$SETUP',
  signature: sig,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('  ✅ 更新 release/latest.json windows-x86_64 条目');
"

echo ""
echo "=== 打包完成 ==="
ls -lh release/ 2>/dev/null || echo "release/ 目录为空"
echo "产物在: $(pwd)/release/"
echo ""
echo "发布步骤:"
echo "  1. 把 release/$SETUP、release/$SETUP_SIG 上传到 GitHub Release v$VER"
echo "  2. 把 release/latest.json 上传到 GitHub Release 的 latest.json"
