#!/usr/bin/env bash
# build-mac.sh — 在 Apple Silicon 或 Intel 宿主上，一次打出 macOS 双架构安装包
# （arm64 / x86_64）。解决「Intel 包在 M1 上打出来是坏的」根因：宿主 npm install
# 只装宿主架构的原生依赖（better-sqlite3 / esbuild / @ast-grep），直接塞进另一架构
# 的包会在目标机加载失败。本脚本：
#   1. 确保两个架构的原生平台包都在 node_modules（非破坏式补齐缺失架构）；
#   2. 构建仓库 runtime（tsup dist/）；
#   3. 对每个 --target 跑 tauri build——beforeBuildCommand 里的 pack-native /
#      stage-runtime-deps / fetch-node-runtime 已按 TAURI_ENV_TARGET_TRIPLE 感知
#      目标架构，自动落对应架构的 better_sqlite3.node 与 Node 运行时。
#
# 用法:
#   bash desktop/scripts/build-mac.sh              # 两个架构都打
#   bash desktop/scripts/build-mac.sh arm64        # 只打 arm64
#   bash desktop/scripts/build-mac.sh x64          # 只打 x64(Intel)
#
# 产物: desktop/src-tauri/target/<triple>/release/bundle/{macos,dmg}/
#
# 签名: 若 desktop/.env 有 TAURI_SIGNING_PRIVATE_KEY，会产出 updater .sig；
#       未设 APPLE_SIGNING_IDENTITY 则 .app/.dmg 未做 Apple 公证——用户首次打开
#       需 `xattr -cr /Applications/Tianshu.app`。
set -euo pipefail

cd "$(dirname "$0")/.."          # → desktop/
DESKTOP_DIR="$(pwd)"
REPO_ROOT="$(cd .. && pwd)"

# ── 解析要打的架构 ──
ARCHS=()
case "${1:-both}" in
  arm64) ARCHS=(arm64) ;;
  x64|intel|x86_64) ARCHS=(x64) ;;
  both|"") ARCHS=(arm64 x64) ;;
  *) echo "✗ 未知参数: $1（支持 arm64 / x64 / both）" >&2; exit 1 ;;
esac

triple_for() { case "$1" in arm64) echo "aarch64-apple-darwin" ;; x64) echo "x86_64-apple-darwin" ;; esac; }
# DMG 文件名里的架构标签，沿用 tauri 约定：arm64→aarch64、x64→x64。
dmg_arch_label() { case "$1" in arm64) echo "aarch64" ;; x64) echo "x64" ;; esac; }
VERSION="$(node -p "require('${DESKTOP_DIR}/src-tauri/tauri.conf.json').version")"

# ── 1. 确保双架构原生平台包都在 node_modules ──
# 宿主 npm 只装宿主架构。补齐缺失架构（非破坏式：直接解包 tarball，不动 npm 依赖树，
# 避免 --cpu/--os 把宿主架构包给删了）。两架构包共存后，esbuild / @ast-grep 的 JS
# loader 在目标机按 arch 自选，pack-native 按 --target 拉对应 better-sqlite3。
ESBUILD_VER="$(node -p "require('${REPO_ROOT}/node_modules/esbuild/package.json').version")"
ASTGREP_VER="$(node -p "require('${REPO_ROOT}/node_modules/@ast-grep/napi/package.json').version")"

ensure_cross_pkg() {  # <pkg> <version>
  local pkg="$1" ver="$2" dest="${REPO_ROOT}/node_modules/$1"
  if [[ -f "${dest}/package.json" ]]; then return 0; fi
  echo "→ 补齐跨架构平台包 ${pkg}@${ver}"
  local tmp; tmp="$(mktemp -d)"
  ( cd "$tmp" && npm pack "${pkg}@${ver}" >/dev/null 2>&1 )
  tar xzf "$tmp"/*.tgz -C "$tmp"
  mkdir -p "$dest"; cp -R "$tmp"/package/. "$dest"/
  rm -rf "$tmp"
}
# 无论打哪个架构，都补齐"另一架构"的平台包，让每个 bundle 同时带两架构原生，运行时自选。
ensure_cross_pkg "@esbuild/darwin-arm64"          "$ESBUILD_VER"
ensure_cross_pkg "@esbuild/darwin-x64"            "$ESBUILD_VER"
ensure_cross_pkg "@ast-grep/napi-darwin-arm64"    "$ASTGREP_VER"
ensure_cross_pkg "@ast-grep/napi-darwin-x64"      "$ASTGREP_VER"

# ── 2. 更新签名密钥（可选）──
if [[ -f "${DESKTOP_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "${DESKTOP_DIR}/.env"; set +a
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    echo "→ 已加载 updater 签名私钥（将产出 .sig）"
  fi
fi
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "⚠ 未设 APPLE_SIGNING_IDENTITY：产物未公证，用户首次打开需 xattr -cr。"
fi

# ── 3. 构建仓库 runtime（tsup dist/）──
echo "→ 构建仓库 runtime（npm run build）…"
( cd "$REPO_ROOT" && npm run build )

# ── DMG 打包（自建，不走 tauri 的 bundle_dmg.sh）──
# tauri 的 bundle_dmg.sh 用 AppleScript 让 Finder 摆图标/背景，在无 GUI/自动化
# 受限的会话里会失败并残留挂载盘。这里用 hdiutil 直接产只读压缩 DMG（含
# /Applications 拖拽符号链接），确定性、可重复、无需 Finder。
make_dmg() {  # <app_path> <out_dmg> <volname>
  local app="$1" out="$2" vol="$3"
  local stage; stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  rm -f "$out"
  hdiutil create -volname "$vol" -srcfolder "$stage" -ov -format UDZO "$out" >/dev/null
  rm -rf "$stage"
  echo "  ✓ DMG → $out"
}

# ── 4. 逐架构 tauri build（只出 .app）+ 自建 DMG ──
for arch in "${ARCHS[@]}"; do
  triple="$(triple_for "$arch")"
  echo ""
  echo "═══ 打包 macOS ${arch} (${triple}) ═══"
  ( cd "$DESKTOP_DIR" && npx tauri build --target "$triple" --bundles app )
  app="${DESKTOP_DIR}/src-tauri/target/${triple}/release/bundle/macos/Tianshu.app"
  if [[ ! -d "$app" ]]; then echo "✗ 未找到 $app" >&2; exit 1; fi
  dmgdir="${DESKTOP_DIR}/src-tauri/target/${triple}/release/bundle/dmg"
  mkdir -p "$dmgdir"
  # 清掉该架构目录里的历史 DMG，避免旧版/坏包混淆（如之前的 Intel 坏包）。
  rm -f "$dmgdir"/Tianshu_*.dmg
  dmg="${dmgdir}/Tianshu_${VERSION}_$(dmg_arch_label "$arch").dmg"
  make_dmg "$app" "$dmg" "Tianshu"
  echo "✓ ${arch} 完成"
done

echo ""
echo "═══ 全部完成 ═══"
for arch in "${ARCHS[@]}"; do
  triple="$(triple_for "$arch")"
  echo "  ${arch}: src-tauri/target/${triple}/release/bundle/{macos/Tianshu.app, dmg/Tianshu_${arch}.dmg}"
done
