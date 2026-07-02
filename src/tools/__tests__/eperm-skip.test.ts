import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectFiles } from '../ast-shared.js'
import { GLOB_TOOL } from '../glob.js'
import type { ToolCallParams } from '../types.js'

/**
 * Integration test: verify that directory traversal silently skips restricted
 * system directories (EPERM/EACCES) while still surfacing errors on the root
 * path and on non-restricted permission-denied directories.
 *
 * Uses real filesystem + chmod 000 to trigger genuine EACCES. The restricted
 * directory is named `.Spotlight-V100` to match the macOS pattern in
 * restricted-paths.ts (no drive-letter prefix needed, works in tmpdir).
 *
 * Platform notes:
 * - Windows: skipped (chmod 000 semantics differ; Windows path matching is
 *   covered by restricted-paths.test.ts unit tests).
 * - Root user: skipped (chmod 000 is ineffective for root).
 */

const isWindows = process.platform === 'win32'
const isRoot = process.getuid?.() === 0
const shouldSkip = isWindows || isRoot

/** Create a temp dir under cwd (not /var/folders — sandboxed tmpdir may block mkdtemp). */
function makeTempDir(prefix: string): string {
  const base = join(process.cwd(), `.${prefix}`)
  if (existsSync(base)) rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  return base
}

describe('EPERM silent-skip integration', { skip: shouldSkip && 'skipped: Windows or root' }, () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = makeTempDir('eperm-skip-test')
  })

  afterEach(() => {
    // Restore permissions before cleanup (chmod 000 dirs are not deletable)
    const tryChmod = (d: string) => {
      try { chmodSync(d, 0o755) } catch { /* already gone or accessible */ }
    }
    for (const sub of ['.Spotlight-V100', 'user-denied']) {
      const p = join(tmpRoot, sub)
      if (existsSync(p)) tryChmod(p)
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('collectFiles silently skips restricted subdir (.Spotlight-V100 + chmod 000)', () => {
    // Layout: <tmp>/src/hit.ts, <tmp>/.Spotlight-V100/ (chmod 000)
    mkdirSync(join(tmpRoot, 'src'), { recursive: true })
    writeFileSync(join(tmpRoot, 'src', 'hit.ts'), 'const x = 1\n')
    mkdirSync(join(tmpRoot, '.Spotlight-V100'))
    writeFileSync(join(tmpRoot, '.Spotlight-V100', 'index.ts'), 'dummy\n')
    chmodSync(join(tmpRoot, '.Spotlight-V100'), 0o000)

    const files = collectFiles(tmpRoot)
    assert.ok(files.some(f => f.includes('hit.ts')), 'should find src/hit.ts')
    assert.ok(!files.some(f => f.includes('.Spotlight-V100')), 'should not include restricted dir files')
  })

  it('collectFiles surfaces error on root path that is restricted', () => {
    // Root dir itself is restricted (depth === 0) → must throw, not return empty
    const restricted = join(tmpRoot, '.Spotlight-V100')
    mkdirSync(restricted)
    chmodSync(restricted, 0o000)

    assert.throws(
      () => collectFiles(restricted),
      (err: NodeJS.ErrnoException) => err.code === 'EACCES' || err.code === 'EPERM',
      'collectFiles on restricted root must throw EACCES/EPERM',
    )
  })

  it('collectFiles surfaces error on non-restricted permission-denied subdir', () => {
    // user-denied/ is chmod 000 but NOT in the restricted patterns → must throw
    mkdirSync(join(tmpRoot, 'src'), { recursive: true })
    writeFileSync(join(tmpRoot, 'src', 'real.ts'), 'const x = 1\n')
    mkdirSync(join(tmpRoot, 'user-denied'))
    writeFileSync(join(tmpRoot, 'user-denied', 'secret.ts'), 'secret\n')
    chmodSync(join(tmpRoot, 'user-denied'), 0o000)

    assert.throws(
      () => collectFiles(tmpRoot),
      (err: NodeJS.ErrnoException) => err.code === 'EACCES' || err.code === 'EPERM',
      'collectFiles with non-restricted denied subdir must throw',
    )
  })

  it('glob surfaces error on root path that is restricted', async () => {
    // Root dir itself is restricted → must return isError, not empty result
    const restricted = join(tmpRoot, '.Spotlight-V100')
    mkdirSync(restricted)
    chmodSync(restricted, 0o000)

    const result = await GLOB_TOOL.execute({
      input: { pattern: '*', path: restricted },
      toolUseId: 'test',
      cwd: restricted,
    } as unknown as ToolCallParams)
    assert.equal(result.isError, true, 'glob on restricted root must return isError')
  })
})
