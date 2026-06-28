#!/usr/bin/env node
/**
 * gen-latest-json.js — 从构建产物生成 Tauri updater 的 `latest.json` 清单。
 *
 * 用法（CI 里，签名构建后调用）：
 *   node scripts/gen-latest-json.js \
 *     --version 0.1.0 \
 *     --notes "首个自动更新版本" \
 *     --bundle-dir src-tauri/target/release/bundle \
 *     --download-base https://github.com/OWNER/REPO/releases/download/v0.1.0
 *
 * 产出 latest.json 到 stdout，Tauri v2 updater 格式：
 *   { version, notes, pub_date, platforms: { "<target>": { url, signature } } }
 *
 * 平台 target 命名遵循 Tauri 约定：darwin-aarch64 / darwin-x86_64 / windows-x86_64。
 * 每个安装包的同目录下需有配对的 `<file>.sig`（createUpdaterArtifacts: true 时 tauri build 自动产出）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const version = arg('version')
const bundleDir = arg('bundle-dir')
const downloadBase = arg('download-base')
const notes = arg('notes') ?? ''
if (!version || !bundleDir || !downloadBase) {
  console.error('用法: gen-latest-json.js --version <v> --bundle-dir <dir> --download-base <url> [--notes <text>]')
  process.exit(1)
}

// 平台 → updater 安装包相对路径（相对 bundleDir）。
// 注意：macOS 的 updater 产物是 .app.tar.gz（createUpdaterArtifacts 才会签名，
// 同目录有配对 .sig）；.dmg 只用于首次手动安装，没有 .sig，不能作 updater 源。
const PLATFORMS = {
  'darwin-aarch64': 'macos/*.app.tar.gz',
  'darwin-x86_64': 'macos/*.app.tar.gz',
  'windows-x86_64': 'nsis/*-setup.exe',
}

// 收集 sig：读 <asset>.sig 同伴文件
function readSig(assetPath) {
  const sigPath = `${assetPath}.sig`
  if (!existsSync(sigPath)) {
    throw new Error(`缺少签名文件 ${sigPath}（确认 tauri.conf.json 设了 createUpdaterArtifacts: true 且构建时注入了 TAURI_SIGNING_PRIVATE_KEY）`)
  }
  return readFileSync(sigPath, 'utf8').trim()
}

function findAsset(sub, pattern) {
  const dir = join(bundleDir, sub)
  if (!existsSync(dir)) return null
  const re = new RegExp(pattern)
  const hit = readdirSync(dir).find((f) => re.test(f))
  return hit ? join(dir, hit) : null
}

// darwin：aarch64 / x86_64 共用同一个 .app.tar.gz（除非分架构构建）。
const darwinAsset = findAsset('macos', /\.app\.tar\.gz$/)
const winAsset = findAsset('nsis', /-setup\.exe$/)

function entry(assetAbsPath) {
  if (!assetAbsPath) return undefined
  const name = assetAbsPath.split('/').pop()
  return {
    url: `${downloadBase}/${name}`,
    signature: readSig(assetAbsPath),
  }
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    ...(darwinAsset && {
      'darwin-aarch64': entry(darwinAsset),
      'darwin-x86_64': entry(darwinAsset),
    }),
    ...(winAsset && { 'windows-x86_64': entry(winAsset) }),
  },
}

process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
