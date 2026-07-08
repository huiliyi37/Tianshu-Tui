#!/usr/bin/env node
/**
 * obfuscate-runtime.js — 对打入桌面端的 CLI runtime JS 产物做混淆加固。
 *
 * 运行时机：Tauri beforeBuildCommand 链中，npm run build && stage-runtime-deps 之后。
 * 目标：dist/ 下所有 .js 文件（main.js + chunk-*.js）。
 * 跳过：dist/seed-capsules/（纯文本），dist/bundled-skills/（用户审计友好），
 *       dist/node_modules/（native dep staging），dist/native/（pack-native 产物）。
 *
 * Shebang 保护：javascript-obfuscator 已知 Issue #185 会破坏 shebang 行。
 * 混淆前提取第一行 `#!/usr/bin/env ...`，混淆后重新 prepend。
 *
 * ignoreImports + target:'node'：保护 CJS/ESM 互操作（import/require/createRequire）。
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { obfuscate } from 'javascript-obfuscator'

const repoRoot = join(import.meta.dirname, '..', '..')
const distDir = join(repoRoot, 'dist')

const OBF_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  ignoreImports: true,
  renameGlobals: false,
  selfDefending: false,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'variable',
  target: 'node',
  transformObjectKeys: false,
  sourceMap: false,
}

const SKIP_DIRS = new Set([
  'seed-capsules',
  'bundled-skills',
  'node_modules',
  'native',
])

function collectJsFiles(dir) {
  const files = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        files.push(...collectJsFiles(full))
      }
    } else if (st.isFile() && extname(entry) === '.js') {
      files.push(full)
    }
  }
  return files
}

const files = collectJsFiles(distDir)

if (files.length === 0) {
  console.log('[obfuscate-runtime] dist/ 中没有 JS 文件，跳过')
  process.exit(0)
}

console.log(`[obfuscate-runtime] 混淆 ${files.length} 个 JS 文件...`)
let passed = 0
let failed = 0

for (const file of files) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (err) {
    console.error(`  ✗ ${basename(file)}: 无法读取 — ${err.message}`)
    failed++
    continue
  }

  // 提取 shebang — javascript-obfuscator 会破坏它 (Issue #185)
  let shebang = ''
  let body = source
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n')
    if (nl >= 0) {
      shebang = body.slice(0, nl + 1)
      body = body.slice(nl + 1)
    } else {
      // 整个文件就是一行 shebang（极端情况）
      shebang = body
      body = ''
    }
  }

  try {
    const result = obfuscate(body, OBF_OPTIONS)
    const output = shebang ? shebang + result.getObfuscatedCode() : result.getObfuscatedCode()
    writeFileSync(file, output, 'utf8')
    console.log(`  ✅ ${basename(file)}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${basename(file)}: ${err.message}`)
    failed++
  }
}

console.log(`[obfuscate-runtime] 完成 — ${passed} 成功${failed > 0 ? `, ${failed} 失败` : ''}`)
if (failed > 0) process.exit(1)
