#!/usr/bin/env bash
# sign-and-build.sh — 生成带更新签名的桌面安装包。
#
# 流程：source 本地 .env（gitignore，绝不入库）读取 TAURI_SIGNING_PRIVATE_KEY
# 与密码，然后执行 tauri build。构建产物会带 .sig 签名文件，可供 updater 校验。
#
# 前置（仅首次）：
#   npx tauri signer generate -w ~/.tauri/tianshu.key
#   → 输出私钥（base64）+ 公钥 + 密码。
#   → 公钥填进 src-tauri/tauri.conf.json 的 plugins.updater.pubkey。
#   → 私钥 + 密码写入本目录 .env（见 .env.example）。
#
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ 缺少 $ENV_FILE。请复制 .env.example 并填入签名私钥/密码。" >&2
  echo "  首次生成密钥：npx tauri signer generate -w ~/.tauri/tianshu.key" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "✗ .env 缺少 TAURI_SIGNING_PRIVATE_KEY" >&2
  exit 1
fi

# 密码可选（生成时若设了密码则必填）
: "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:=}"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# ── macOS Developer ID 签名 + 公证状态自检（仅提示，不阻断） ──
# APPLE_* 已由上面的 `set -a; source .env` 自动导出，tauri build 会自取。
# 嵌套二进制（Node 运行时 / .node / esbuild）由 beforeBuildCommand 里的
# codesign-nested.js 在打包前预签——它同样读 APPLE_SIGNING_IDENTITY。
if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    echo "→ macOS：将用 Developer ID 签名（含嵌套 Node/.node/esbuild）。"
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
      echo "  并提交 Apple 公证（notarization）→ 用户下载后双击即开。"
    else
      echo "  ⚠ 缺少 APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID：" >&2
      echo "    产物会被签名但【不会公证】，下载后仍会被 Gatekeeper 拦截（报“已损坏”）。" >&2
      echo "    要彻底解决请补全这三项再重打。" >&2
    fi
  else
    echo "⚠ 未设置 APPLE_SIGNING_IDENTITY：产物【未签名/未公证】。" >&2
    echo "  用户下载后会报“已损坏”，需手动执行：xattr -cr /Applications/天枢.app" >&2
  fi
fi

echo "→ 先构建 runtime（仓库根 dist/）…"
( cd .. && npm run build )

echo "→ 下载/刷新 Node 运行时…"
node scripts/fetch-node-runtime.js

echo "→ 执行签名构建（tauri build）…"
npm run tauri:build

echo "✓ 完成。安装包 + .sig 签名见 src-tauri/target/release/bundle/"
echo "  发布时把安装包、.sig、以及 gen-latest-json.js 产出的 latest.json 一起上传到 GitHub Release。"
