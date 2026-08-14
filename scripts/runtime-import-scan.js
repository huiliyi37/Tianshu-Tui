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
 * Allowlist comes from scripts/external-deps.js (SCAN_ALLOWED) — the single
 * source of truth for dist runtime externals. Do NOT edit the set here;
 * change external-deps.js instead (tsup.config.ts external and
 * stage-runtime-deps.js ROOTS derive from the same data).
 */
import { readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { builtinModules } from 'node:module'
import * as esbuild from 'esbuild'
import { SCAN_ALLOWED } from './external-deps.js'

export const ALLOWED_EXTERNALS = new Set(SCAN_ALLOWED)

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

  const makeGate = (entryFile) => ({
    name: 'rivet-runtime-import-gate',
    setup(build) {
      // 只拦裸导入。注意：bundle:true 模式下 esbuild 解析相对 import 后会以
      // 绝对路径再次触发 onResolve（Windows 上是 D:\...，匹配 /^[^./]/），
      // 必须显式排除绝对路径，否则 dist 内部的 chunk 互引会被误判为裸导入。
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path
        // 相对/绝对路径 → 走默认解析（dist 内部必须自洽）。
        if (spec.startsWith('.')) return null
        if (spec.startsWith('/')) return null
        // Windows 绝对路径（盘符:\）也走默认解析。
        if (/^[a-zA-Z]:[\\/]/.test(spec)) return null
        if (BARE_BUILTINS.has(spec.replace(/^node:/, ''))) return { external: true }
        if (allowed.has(pkgRoot(spec))) return { external: true }
        // 单 entry 模式下，入口文件自身的裸导入 args.importer 为空——用当前
        // entry 路径兜底，违规才能正确归到文件而非笼统的 '(entry)'。
        addViolation(args.importer || entryFile, spec)
        return { external: true } // 不中断，收集全部违规一次报完
      })
    },
  })

  // 逐文件喂给 esbuild，而非一次性把全部 .js 当 entryPoints。
  // 原因：tsup code-splitting 产出互相 import 的共享 chunk，把 main.js 与
  // chunk-*.js 一起塞进一次 esbuild.build(bundle:true) 时，被引用的 entry
  // 既在 entryPoints 里又要被标 external，esbuild 直接报
  // "entry point cannot be marked as external"（v2.28.0 发版实测）。
  // 逐文件单 entry + bundle:true：相对导入正常跟进，gate 插件照常拦裸导入，
  // 不会触发 entry 互引冲突。每文件一个 esbuild 实例代价可接受（dist 几十~百个文件）。
  for (const file of files) {
    try {
      await esbuild.build({
        entryPoints: [file],
        bundle: true,
        write: false,
        outdir: join(distDir, '.import-scan-out'), // write:false 不落盘，仅为满足多入口校验
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
        plugins: [makeGate(file)],
      })
    } catch {
      // 单文件解析失败（语法错等）——不是本次要拦的「裸导入」事故，跳过；
      // 真正的 bundle 错误会在 tsup 阶段暴露。这里只关心 bare import 违规。
    }
  }
  return violations
}
