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
 *
 * ── 构建期 ABI 断言（防「静默丢持久化」）────────────────────────────────
 * dist/native/ 的二进制 **只被桌面 sidecar 加载**（npm 发布的 CLI 把 dist/native
 * 排除在 files 外，靠用户安装时 npm rebuild 自己的 better-sqlite3）。桌面 sidecar
 * 跑的是 fetch-node-runtime.js 打包进去的固定 Node（默认 24.1.0 → ABI 137），
 * **不是**构建机的 Node。若构建机在 Node 24（ABI 137）下打包，二进制 ABI 与运行时
 * 不匹配 → 加载失败 → 退化成 nullDb → 跨会话知识/claims/registry 全部静默失能。
 *
 * 这里在打包后强制校验「二进制 ABI == 目标运行时 ABI」，不匹配 fail-closed，
 * 把「发到用户手里才发现」提前到构建期硬失败。目标 Node 版本与 fetch-node-runtime
 * 同源：优先 env NODE_VERSION，否则默认 DEFAULT_TARGET_NODE_VERSION。
 * 逃生舱：PACK_NATIVE_SKIP_ABI_CHECK=1 跳过（仅限明确知道自己在干什么的场景）。
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 脚本在 scripts/，仓库根在上一级
const repoRoot = join(__dirname, '..')

const SOURCE = join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const TARGET_DIR = join(repoRoot, 'dist', 'native')
const TARGET = join(TARGET_DIR, 'better_sqlite3.node')

// 目标运行时版本与 desktop/scripts/fetch-node-runtime.js 单一同源：直接 import 其
// DEFAULT_NODE_VERSION，杜绝两处常量漂移（漂移会让本断言失去意义）。import 失败
// （脚本被移动/单独取用）时退回硬编码兜底，并打一行提示。
let DEFAULT_TARGET_NODE_VERSION = '24.1.0'
try {
  const mod = await import('../desktop/scripts/fetch-node-runtime.js')
  if (mod && typeof mod.DEFAULT_NODE_VERSION === 'string') {
    DEFAULT_TARGET_NODE_VERSION = mod.DEFAULT_NODE_VERSION
  }
} catch {
  console.warn('⚠ pack-native: 无法从 fetch-node-runtime.js 读取 DEFAULT_NODE_VERSION，使用兜底 %s', DEFAULT_TARGET_NODE_VERSION)
}

// NODE_MODULE_VERSION（ABI）↔ Node 主版本映射。仅在「打包机 Node 主版本 ≠ 目标
// 主版本」时才需要查表；同主版本直接用 process.versions.modules，免维护。
const ABI_BY_MAJOR = {
  18: 108,
  19: 111,
  20: 115,
  21: 120,
  22: 127,
  23: 131,
  24: 137,
  // 新增主版本请在此补 NODE_MODULE_VERSION（来源 https://nodejs.org/api/process.html
  // #processversionsmodules 或目标 Node 的 `node -p process.versions.modules`）。
  // 未登记的主版本会被 resolveTargetAbi 判为 null → fail-closed 报错提示补表，
  // 绝不臆测放行。
}

const currentMajor = Number(process.versions.node.split('.')[0])
const currentAbi = Number(process.versions.modules)

/** 目标运行时（桌面 sidecar 的 bundled Node）的主版本。 */
function resolveTargetNodeVersion() {
  return process.env.NODE_VERSION || DEFAULT_TARGET_NODE_VERSION
}

/** 目标运行时 ABI；同主版本走精确值（process.versions.modules），跨版本查表。 */
function resolveTargetAbi(targetMajor) {
  if (targetMajor === currentMajor) return currentAbi
  return ABI_BY_MAJOR[targetMajor] ?? null
}

/**
 * 探测一个 .node 原生模块的 ABI。
 * - require 成功 → 二进制 ABI 与当前进程一致，返回 currentAbi。
 * - require 失败且是 NODE_MODULE_VERSION 不匹配 → 错误串里第一个数字就是二进制 ABI。
 * - 其他加载失败（缺依赖/架构不符等）→ 返回 { abi: null, error }，原样上报。
 */
function detectBinaryAbi(binaryPath) {
  try {
    createRequire(import.meta.url)(binaryPath)
    return { abi: currentAbi, loaded: true }
  } catch (err) {
    const msg = String((err && err.message) || err)
    // "...was compiled against a different Node.js version using
    //  NODE_MODULE_VERSION 127. This version of Node.js requires
    //  NODE_MODULE_VERSION 137."
    // 第一个数字 = 二进制编译时的 ABI；第二个 = 当前进程要求的 ABI。
    const m = /NODE_MODULE_VERSION (\d+)/.exec(msg)
    if (m) return { abi: Number(m[1]), loaded: false }
    return { abi: null, loaded: false, error: msg }
  }
}

function assertAbi() {
  if (process.env.PACK_NATIVE_SKIP_ABI_CHECK === '1') {
    console.warn('⚠ pack-native: PACK_NATIVE_SKIP_ABI_CHECK=1 — 跳过 ABI 断言（自担风险）')
    return
  }

  const targetVersion = resolveTargetNodeVersion()
  const targetMajor = Number(targetVersion.split('.')[0])
  const targetAbi = resolveTargetAbi(targetMajor)

  const { abi: binaryAbi, error } = detectBinaryAbi(TARGET)

  if (binaryAbi === null) {
    console.error(
      '❌ pack-native: 无法探测 better_sqlite3.node 的 ABI（非 NODE_MODULE_VERSION 类错误）。\n' +
      `   加载错误: ${error}\n` +
      '   多半是架构不符或依赖缺失。请重新安装/重编 better-sqlite3 后再打包。',
    )
    process.exit(1)
  }

  if (targetAbi === null) {
    console.error(
      `❌ pack-native: 未知的目标 Node 主版本 v${targetMajor}（NODE_VERSION=${targetVersion}）。\n` +
      `   无法核对 ABI。请在 scripts/pack-native.js 的 ABI_BY_MAJOR 中补上 v${targetMajor} 的 NODE_MODULE_VERSION，\n` +
      '   或用 PACK_NATIVE_SKIP_ABI_CHECK=1 显式跳过。',
    )
    process.exit(1)
  }

  if (binaryAbi !== targetAbi) {
    console.error(
      '❌ pack-native: ABI 不匹配 —— 打包的 better_sqlite3.node 会在桌面 sidecar 里加载失败，\n' +
      '   静默退化成 nullDb（跨会话知识/claims/registry 全部失能，且只打一行 warning）。\n' +
      `     二进制 ABI (NODE_MODULE_VERSION): ${binaryAbi}\n` +
      `     目标运行时 ABI: ${targetAbi}  (Node v${targetVersion}, 来自 ${process.env.NODE_VERSION ? 'env NODE_VERSION' : 'DEFAULT_TARGET_NODE_VERSION'})\n` +
      `     当前打包机 Node: v${process.versions.node} (ABI ${currentAbi})\n` +
      '   修复方式（任选其一）：\n' +
      `     · 用目标 Node v${targetVersion} 运行 \`npm rebuild better-sqlite3\` 后重新打包；\n` +
      '     · 若要把桌面运行时一并升到新版本，改 fetch-node-runtime.js 的\n' +
      '       DEFAULT_NODE_VERSION 即可（本脚本 import 同源），并核对 ABI_BY_MAJOR 有该版本；\n' +
      '     · 临时绕过：PACK_NATIVE_SKIP_ABI_CHECK=1（不推荐，会把风险带进产物）。',
    )
    process.exit(1)
  }

  console.log(
    `✅ pack-native: ABI 校验通过 — 二进制/目标运行时同为 NODE_MODULE_VERSION ${binaryAbi} (Node v${targetVersion})`,
  )
}

if (!existsSync(SOURCE)) {
  console.error('⚠ pack-native: better-sqlite3 native binary not found at %s — skipping', SOURCE)
  process.exit(0)
}

mkdirSync(TARGET_DIR, { recursive: true })
copyFileSync(SOURCE, TARGET)

const sizeKb = Math.round(statSync(TARGET).size / 1024)
console.log('✅ Packed better_sqlite3.node (%dKB) → %s', sizeKb, TARGET)

assertAbi()
