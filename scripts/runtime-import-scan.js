/**
 * runtime-import-scan.js — verify every import in the bundled dist output can
 * resolve in the packaged sidecar.
 *
 * Why this exists (2026-08-02 留痕):
 *   The v2.27.0 packaged sidecar crashed at startup with
 *   `ERR_MODULE_NOT_FOUND: Cannot find package 'pixelmatch'` — the shipped
 *   chunk kept a bare `import pixelmatch from "pixelmatch"` even though
 *   tsup.config.ts lists pixelmatch/pngjs in `noExternal` and a clean rebuild
 *   inlines them correctly. Whatever transient state produced that build, the
 *   failure mode is the same: a pure-JS dep left as a bare import is fatal in
 *   the packaged app (rivet-runtime/ ships only the staged node_modules).
 *   This scanner is the fail-closed gate: it re-walks the dist import graph
 *   with esbuild and any bare specifier outside the known-externals allowlist
 *   is a build error, caught before packaging. (正则扫字符串会把 ajv codegen
 *   模板里的 require("ajv/...") 文本误报成裸导入，所以走真解析。)
 *
 * Allowlist mirrors the packages resolvable at runtime in the packaged app:
 *   - tsup.config.ts `external`（esbuild / better-sqlite3 / @ast-grep/* /
 *     web-tree-sitter / tree-sitter-wasms / typescript / react-devtools-core /
 *     mammoth）——由 stage-runtime-deps.js 随包分发或特性门后惰性解析；
 *   - playwright-core —— 变量化动态 import，tsup 无法内联，随包分发；
 *   - @mariozechner/clipboard —— 可选剪贴板原生库，未安装时静默回退 shell
 *     链（clipboard-image.ts），与 mammoth 同类。
 * tsup.config.ts / stage-runtime-deps.js 变动时保持同步。
 */
import { readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { builtinModules } from 'node:module'
import * as esbuild from 'esbuild'

export const ALLOWED_EXTERNALS = new Set([
  'esbuild',
  'better-sqlite3',
  '@ast-grep/napi',
  '@ast-grep/lang-json',
  '@ast-grep/lang-python',
  'web-tree-sitter',
  'tree-sitter-wasms',
  'typescript',
  'react-devtools-core',
  'mammoth',
  'playwright-core',
  '@mariozechner/clipboard',
])

const SKIP_DIRS = new Set(['node_modules', 'native', 'bundled-skills', 'seed-capsules'])

const BARE_BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, '')))

/** 'pkg/sub/path' → 'pkg'; '@scope/pkg/sub' → '@scope/pkg'. */
export function pkgRoot(spec) {
  if (spec.startsWith('@')) {
    return spec.split('/').slice(0, 2).join('/')
  }
  return spec.split('/')[0]
}

function collectJsFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
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
      if (!SKIP_DIRS.has(entry)) collectJsFiles(full, out)
    } else if (st.isFile() && extname(entry) === '.js') {
      out.push(full)
    }
  }
  return out
}

/**
 * Re-resolve every import/require in every .js bundle under distDir the way
 * the packaged sidecar would: node builtins pass, allowlisted externals pass,
 * relative imports resolve inside dist — anything else is a violation.
 * Returns a Map<filePath, Set<spec>>; empty map = bundle is self-contained.
 */
export async function scanDist(distDir, { allowed = ALLOWED_EXTERNALS } = {}) {
  const violations = new Map()
  const files = collectJsFiles(distDir)
  if (files.length === 0) return violations

  const addViolation = (importer, spec) => {
    if (!violations.has(importer)) violations.set(importer, new Set())
    violations.get(importer).add(spec)
  }

  const gate = {
    name: 'rivet-runtime-import-gate',
    setup(build) {
      // 只拦裸导入；相对/绝对路径走默认解析（dist 内部必须自洽，解析失败
      // esbuild 会原样报错，同样是打包事故）。
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const spec = args.path
        if (BARE_BUILTINS.has(spec.replace(/^node:/, ''))) return { external: true }
        if (allowed.has(pkgRoot(spec))) return { external: true }
        addViolation(args.importer || '(entry)', spec)
        return { external: true } // 不中断，收集全部违规一次报完
      })
    },
  }

  await esbuild.build({
    entryPoints: files,
    bundle: true,
    write: false,
    outdir: join(distDir, '.import-scan-out'), // write:false 不落盘，仅为满足多入口校验
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [gate],
  })
  return violations
}
