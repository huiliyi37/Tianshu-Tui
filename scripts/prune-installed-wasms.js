#!/usr/bin/env node
/**
 * prune-installed-wasms.js — npm 安装后裁剪 tree-sitter-wasms 的多余语法 wasm。
 *
 * 背景：tree-sitter-wasms 整包约 50MB（40+ 语言 grammar），但运行时只有
 * src/repo/meridian-parser.ts 加载 TS/Python/Go 三个（见 LANG_WASM）。
 * 桌面 sidecar 打包期已由 stage-runtime-deps.js 裁剪；npm 用户走 postinstall，
 * 在这里对已安装到 node_modules 的副本做同样裁剪，把安装体积砍掉 ~47MB。
 *
 * 安全语义：
 *   - pnpm 内容寻址 store（路径含 .pnpm）会污染共享缓存 → 跳过
 *   - 任何异常只告警不阻断安装（裁剪失败只是体积大，功能不受影响）
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pruneTreeSitterWasms } from './tree-sitter-wasm-keep.js'

try {
  const req = createRequire(import.meta.url)
  const wasmsPkgJson = req.resolve('tree-sitter-wasms/package.json')
  const pkgRoot = dirname(wasmsPkgJson)

  if (pkgRoot.includes('.pnpm')) {
    console.log('[prune-installed-wasms] pnpm 共享 store，跳过裁剪')
    process.exit(0)
  }

  const outDir = join(pkgRoot, 'out')
  if (!existsSync(outDir)) {
    console.log('[prune-installed-wasms] tree-sitter-wasms/out 不存在，跳过')
    process.exit(0)
  }

  const { kept, removed } = pruneTreeSitterWasms(outDir)
  if (removed.length > 0) {
    console.log(
      `[prune-installed-wasms] 保留 ${kept.length} 个 grammar（${kept.join(', ')}），裁剪 ${removed.length} 个`,
    )
  } else {
    console.log('[prune-installed-wasms] 已是最小集，无需裁剪')
  }
} catch (err) {
  console.warn('[prune-installed-wasms] 裁剪失败（不影响功能）:', err && err.message ? err.message : err)
}
