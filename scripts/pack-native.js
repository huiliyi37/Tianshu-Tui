#!/usr/bin/env node
/**
 * Pack better-sqlite3 native binary into dist/native/.
 * Called after `npm run build` and before `tauri:build`.
 *
 * 跨平台版（替代 pack-native.sh）：纯 Node 实现，不依赖 bash，Windows 原生
 * CMD/PowerShell 也能跑。与 desktop/scripts/fetch-node-runtime.js 同口径。
 *
 * Idempotent: safe to run multiple times. Skips silently (exit 0) if
 * better-sqlite3 is not installed — the nullDb fallback handles it.
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 脚本在 scripts/，仓库根在上一级
const repoRoot = join(__dirname, '..')

const SOURCE = join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const TARGET_DIR = join(repoRoot, 'dist', 'native')
const TARGET = join(TARGET_DIR, 'better_sqlite3.node')

if (!existsSync(SOURCE)) {
  console.error('⚠ pack-native: better-sqlite3 native binary not found at %s — skipping', SOURCE)
  process.exit(0)
}

mkdirSync(TARGET_DIR, { recursive: true })
copyFileSync(SOURCE, TARGET)

const sizeKb = Math.round(statSync(TARGET).size / 1024)
console.log('✅ Packed better_sqlite3.node (%dKB) → %s', sizeKb, TARGET)
