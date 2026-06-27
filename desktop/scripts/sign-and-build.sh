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

echo "→ 先构建 runtime（仓库根 dist/）…"
( cd .. && npm run build )

echo "→ 下载/刷新 Node 运行时…"
node scripts/fetch-node-runtime.js

echo "→ 执行签名构建（tauri build）…"
npm run tauri:build

echo "✓ 完成。安装包 + .sig 签名见 src-tauri/target/release/bundle/"
echo "  发布时把安装包、.sig、以及 gen-latest-json.js 产出的 latest.json 一起上传到 GitHub Release。"
