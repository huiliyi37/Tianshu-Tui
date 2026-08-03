#!/usr/bin/env node
/**
 * assert-runtime-imports.js — fail the build when dist/ bundles contain bare
 * imports that the packaged sidecar cannot resolve.
 *
 * 运行时机：Tauri beforeBuildCommand 链中，stage-runtime-deps 之后、
 * obfuscate-runtime 之前。dist/ 里出现 allowlist 之外的裸导入 = 纯 JS 依赖
 * 没被 tsup 内联 —— 打包后必崩 ERR_MODULE_NOT_FOUND（v2.27.0 pixelmatch
 * 事故，2026-08-02）。宁可构建失败，不发残包。
 *
 * 用法: node scripts/assert-runtime-imports.js [distDir]
 */
import { join, relative } from 'node:path'
import { scanDist } from './runtime-import-scan.js'

const repoRoot = join(import.meta.dirname, '..')
const distDir = process.argv[2] ?? join(repoRoot, 'dist')

const violations = await scanDist(distDir)
if (violations.size > 0) {
  console.error('✗ assert-runtime-imports: dist/ 含无法随包解析的裸导入（纯 JS 依赖未内联？）')
  for (const [file, specs] of violations) {
    console.error(`  ${relative(distDir, file)}: ${[...specs].join(', ')}`)
  }
  console.error('  修复：把包加入 tsup.config.ts noExternal 内联，或加入 stage-runtime-deps ROOTS 随包分发。')
  process.exit(1)
}
console.log('✅ assert-runtime-imports: dist/ 所有导入均可随包解析')
