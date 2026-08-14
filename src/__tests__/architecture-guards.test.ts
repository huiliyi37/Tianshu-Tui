/**
 * Architecture guards — CI-level source-code pattern scanning.
 *
 * Turns design constraints into red/green tests. Inspired by grok-build's
 * guard.rs (compile-time API ban via test scan).
 *
 * Each guard scans src/ for forbidden patterns. When a new violation is
 * introduced, the test fails with a clear message pointing to the file.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { MAX_LINES_BASELINE, MAX_LINES_REDLINE, countPhysicalLines } from '../agent/structure-gate.js'

const SRC_ROOT = join(process.cwd(), 'src')

/** Recursively collect .ts files under a directory. */
function collectTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

interface Violation {
  file: string
  line: number
  content: string
}

/**
 * Scan one file's lines for a forbidden pattern, skipping comment lines
 * (`//`, `/*`, and `*` block-comment continuations). Pure — exported into the
 * self-check below so the skip logic can never silently short-circuit again
 * (the original `startsWith('')` typo made every line skip and the guard
 * scanned nothing for its whole life).
 */
function scanLines(lines: string[], pattern: RegExp): Array<{ line: number; content: string }> {
  const hits: Array<{ line: number; content: string }> = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (pattern.test(line)) {
      hits.push({ line: i + 1, content: trimmed })
    }
  })
  return hits
}

/** Scan for a regex pattern across source files, returning violations. */
function scanPattern(
  files: string[],
  pattern: RegExp,
  whitelist: string[] = [],
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    if (whitelist.some(w => file.includes(w))) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const hit of scanLines(lines, pattern)) {
      violations.push({ file: relative(SRC_ROOT, file), ...hit })
    }
  }
  return violations
}

const allSrcFiles = collectTsFiles(SRC_ROOT)

// —— max-lines 棘轮 ——
// 基线表与红线值住在 src/agent/structure-gate.ts（deliver_task 的 YELLOW
// 预警门共用同一张表）；本测试是硬门：超限即红。语义详见该模块 JSDoc。

describe('architecture guards', () => {
  test('guards actually scan (self-check: skip logic and corpus are live)', () => {
    // 回归自检：曾因 startsWith('') 恒真导致每行被跳过，guard 全程空扫。
    // 植入violation必须被抓到；注释行必须被跳过；语料必须非空。
    const planted = scanLines(['const x = process.stdout.write("boom")'], /process\.stdout\.write\s*\(/)
    assert.equal(planted.length, 1, 'scanLines must catch a planted violation (empty-scan regression)')
    const commented = scanLines(
      ['// process.stdout.write("a")', '* process.stdout.write("b")', '/* process.stdout.write("c") */'],
      /process\.stdout\.write\s*\(/,
    )
    assert.equal(commented.length, 0, 'comment lines must be skipped, nothing else')
    assert.ok(allSrcFiles.length > 100, `src corpus suspiciously small: ${allSrcFiles.length} files`)
  })

  test('no direct process.stdout.write outside LiveEngine', () => {
    // 白名单：/tui/engine/ 是渲染回路的唯一合法直写层；cli/、headless.ts、
    // main.ts 是无 LiveEngine 竞争的进程入口面（banner/错误/非 TUI 子命令）。
    // TUI 运行态内的直写（如曾经的 slash-commands /clear）一律违规。
    const whitelist = ['/tui/engine/', '/__tests__/', '/cli/', 'src/headless.ts', 'src/main.ts']
    const scanned = allSrcFiles.filter(f => !whitelist.some(w => f.includes(w)))
    assert.ok(scanned.length > 0, 'guard corpus empty after whitelist — guard would scan nothing')
    const violations = scanPattern(
      allSrcFiles,
      /process\.stdout\.write\s*\(/,
      whitelist,
    )
    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} direct process.stdout.write call(s) outside LiveEngine:\n` +
        violations.map(v => `  ${v.file}:${v.line}`).join('\n'),
    )
  })

  test('spawn calls without windowsHide (threshold check)', () => {
    // Best-effort scan: flag spawn/spawnSync that lack windowsHide:true
    // in the 10-line window after the call. Allows detached+stdio:ignore.
    const guardFiles = allSrcFiles.filter(f => !f.includes('/__tests__/'))
    assert.ok(guardFiles.length > 0, 'spawn guard corpus empty — guard would scan nothing')
    const violations: Violation[] = []
    for (const file of guardFiles) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.includes('import ')) return
        if (!/(?:^|[^\w.])(?:spawn|spawnSync)\s*\(/.test(trimmed)) return
        const window = lines.slice(i, Math.min(i + 10, lines.length)).join('\n')
        const hasHide = /windowsHide\s*:\s*true/.test(window)
        const isDetachedIgnore = /detached\s*:\s*true/.test(window) && /stdio.*ignore/.test(window)
        if (!hasHide && !isDetachedIgnore) {
          violations.push({ file: relative(SRC_ROOT, file), line: i + 1, content: trimmed })
        }
      })
    }
    // Baseline: internal sync spawnSync calls (platform.ts, resolved-env.ts, etc.)
    // Guard prevents NEW long-running spawn calls without windowsHide from being added.
    assert.ok(
      violations.length <= 25,
      `Spawn guard: ${violations.length} violations (baseline 25, new additions must add windowsHide):\n` +
        violations.map(v => `  ${v.file}:${v.line}`).join('\n'),
    )
  })

  test('max-lines ratchet: named monoliths only shrink; other files stay under redline', () => {
    const baseline = new Map<string, number>(MAX_LINES_BASELINE)
    // 自检 1：基线不得指向已消失的文件（拆分/改名/删除时同 PR 更新基线表）。
    const ghosts = [...baseline.keys()].filter(p => !existsSync(join(process.cwd(), p)))
    assert.deepEqual(
      ghosts,
      [],
      `MAX_LINES_BASELINE has entries pointing at missing files — update the table in the same change:\n` +
        ghosts.map(p => `  ${p}`).join('\n'),
    )
    // 自检 2：守备语料非空（防再度空扫）。
    const productFiles = allSrcFiles.filter(f => !f.includes(`${sep}__tests__${sep}`))
    assert.ok(productFiles.length > 100, `max-lines corpus suspiciously small: ${productFiles.length} files`)

    const overCeiling: string[] = []
    const overRedline: string[] = []
    for (const file of productFiles) {
      const rel = relative(process.cwd(), file).split(sep).join('/')
      const lines = countPhysicalLines(readFileSync(file, 'utf8'))
      const ceiling = baseline.get(rel)
      if (ceiling !== undefined) {
        if (lines > ceiling) overCeiling.push(`  ${rel}: ${lines} 行 > ceiling ${ceiling}`)
      } else if (lines > MAX_LINES_REDLINE) {
        overRedline.push(`  ${rel}: ${lines} 行 > 红线 ${MAX_LINES_REDLINE}`)
      }
    }
    assert.equal(
      overCeiling.length,
      0,
      `点名巨石只降不升——沿接缝拆分，而不是继续膨胀；确需增长时在同一 PR 修改 MAX_LINES_BASELINE 并说明理由：\n` +
        overCeiling.join('\n'),
    )
    assert.equal(
      overRedline.length,
      0,
      `非基线文件超过 ${MAX_LINES_REDLINE} 行红线——新模块请按职责拆分；确属单一职责的大文件在同一 PR 加入 MAX_LINES_BASELINE 并说明理由：\n` +
        overRedline.join('\n'),
    )
  })
})
