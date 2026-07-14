#!/usr/bin/env bash
# build-mac.sh — 在 Apple Silicon 或 Intel 宿主上打出 macOS 单架构安装包
# （arm64 或 x86_64，可一次 both）。每个产物只携带目标架构的 Node / esbuild /
# @ast-grep，避免历史上「双架构同包」把 .app 撑到 ~370MB。
#
# 交叉编译仍安全：pack-native / stage-runtime-deps / fetch-node-runtime 按
# TAURI_ENV_TARGET_TRIPLE 感知目标架构；本脚本在 tauri build 后对 .app 再跑
# prune + assert，防止 resources/node 累加残留。
#
# 用法:
#   bash desktop/scripts/build-mac.sh              # 两个架构都打（各出一份单架构包）
#   bash desktop/scripts/build-mac.sh arm64        # 只打 arm64
#   bash desktop/scripts/build-mac.sh x64          # 只打 x64(Intel)
#
# 产物: desktop/src-tauri/target/<triple>/release/bundle/{macos,dmg}/
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
dmg_arch_label() { case "$1" in arm64) echo "aarch64" ;; x64) echo "x64" ;; esac; }
VERSION="$(node -p "require('${DESKTOP_DIR}/src-tauri/tauri.conf.json').version")"

# ── 1. 按「当前要打的 arch」补齐平台包（不强制双架构进同一包）──
# 宿主 npm 只装宿主架构。缺失时用 tarball 非破坏式补齐，避免 npm --cpu/--os
# 把另一套删掉（开发机上两套可共存，但 stage-runtime-deps 只会拷目标套）。
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

ensure_native_for_arch() {  # arm64|x64
  local arch="$1"
  case "$arch" in
    arm64)
      ensure_cross_pkg "@esbuild/darwin-arm64" "$ESBUILD_VER"
      ensure_cross_pkg "@ast-grep/napi-darwin-arm64" "$ASTGREP_VER"
      ;;
    x64)
      ensure_cross_pkg "@esbuild/darwin-x64" "$ESBUILD_VER"
      ensure_cross_pkg "@ast-grep/napi-darwin-x64" "$ASTGREP_VER"
      ;;
  esac
}

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

# ── 4. 逐架构 tauri build（只出 .app）+ 单架构 prune/assert + 自建 DMG ──
for arch in "${ARCHS[@]}"; do
  triple="$(triple_for "$arch")"
  echo ""
  echo "═══ 打包 macOS ${arch} (${triple}) ═══"
  ensure_native_for_arch "$arch"
  ( cd "$DESKTOP_DIR" && npx tauri build --target "$triple" --bundles app )
  app="${DESKTOP_DIR}/src-tauri/target/${triple}/release/bundle/macos/Tianshu.app"
  if [[ ! -d "$app" ]]; then echo "✗ 未找到 $app" >&2; exit 1; fi
  res="${app}/Contents/Resources"
  echo "→ prune + assert single-arch resources (${arch})…"
  node "${DESKTOP_DIR}/scripts/prune-bundle-arch.js" "$res" "$triple"
  node "${DESKTOP_DIR}/scripts/assert-bundle-arch.js" "$res" "$triple"
  echo "  node-runtime: $(du -sh "${res}/node-runtime" | awk '{print $1}')"
  ls "${res}/node-runtime" || true
  dmgdir="${DESKTOP_DIR}/src-tauri/target/${triple}/release/bundle/dmg"
  mkdir -p "$dmgdir"
  rm -f "$dmgdir"/Tianshu_*.dmg
  dmg="${dmgdir}/Tianshu_${VERSION}_$(dmg_arch_label "$arch").dmg"
  make_dmg "$app" "$dmg" "Tianshu"
  echo "✓ ${arch} 完成"
done

echo ""
echo "═══ 全部完成 ═══"
for arch in "${ARCHS[@]}"; do
  triple="$(triple_for "$arch")"
  echo "  ${arch}: src-tauri/target/${triple}/release/bundle/{macos/Tianshu.app, dmg/Tianshu_${VERSION}_$(dmg_arch_label "$arch").dmg}"
done
