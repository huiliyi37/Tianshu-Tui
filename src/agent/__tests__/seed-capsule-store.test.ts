import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import {
  loadAllCapsules,
  renderAllCapsulesBlock,
  clearCapsuleCache,
  type SeedCapsule,
} from '../seed-capsule-store.js'

describe('seed-capsule-store', () => {
  let tmpDir: string

  beforeEach(() => {
    clearCapsuleCache()
    tmpDir = mkdtempSync(join(os.tmpdir(), 'capsule-test-'))
  })

  // 清理临时目录
  function cleanup() {
    try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  }

  it('returns empty array when docs/ does not exist', () => {
    const capsules = loadAllCapsules(tmpDir)
    assert.deepEqual(capsules, [])
    cleanup()
  })

  it('returns empty array when docs/ has no capsule files', () => {
    mkdirSync(join(tmpDir, 'docs'))
    writeFileSync(join(tmpDir, 'docs', 'other.md'), 'hello')
    const capsules = loadAllCapsules(tmpDir)
    assert.deepEqual(capsules, [])
    cleanup()
  })

  it('loads a single capsule from seed-capsule-*.md', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  天璇的方法。',
      '</seed-capsule>',
    ].join('\n'))

    const capsules = loadAllCapsules(tmpDir)
    assert.equal(capsules.length, 1)
    assert.equal(capsules[0]!.star, '天璇')
    assert.equal(capsules[0]!.sealedAt, '2026-05-21')
    assert.equal(capsules[0]!.raw, '天璇的方法。')
    assert.ok(capsules[0]!.block.includes('seed-capsule star="天璇"'))
    cleanup()
  })

  it('loads multiple capsules sorted by sealedAt', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-tianfu.md'), [
      '<seed-capsule star="天府" sealed="2026-06-02">',
      '  天府的方法。',
      '</seed-capsule>',
    ].join('\n'))
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  天璇的方法。',
      '</seed-capsule>',
    ].join('\n'))

    const capsules = loadAllCapsules(tmpDir)
    assert.equal(capsules.length, 2)
    // sorted: 天璇 first (2026-05-21), 天府 second (2026-06-02)
    assert.equal(capsules[0]!.star, '天璇')
    assert.equal(capsules[1]!.star, '天府')
    cleanup()
  })

  it('skips files without valid seed-capsule tag', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-broken.md'), 'no tag here')

    const capsules = loadAllCapsules(tmpDir)
    assert.equal(capsules.length, 0)
    cleanup()
  })

  it('caches results for same cwd', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  cached.',
      '</seed-capsule>',
    ].join('\n'))

    const first = loadAllCapsules(tmpDir)
    const second = loadAllCapsules(tmpDir)
    assert.strictEqual(first, second) // same reference
    cleanup()
  })

  it('reloads when cwd changes', () => {
    const docsDir1 = join(tmpDir, 'docs')
    mkdirSync(docsDir1)
    writeFileSync(join(docsDir1, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  first.',
      '</seed-capsule>',
    ].join('\n'))

    const tmpDir2 = mkdtempSync(join(os.tmpdir(), 'capsule-test2-'))
    const docsDir2 = join(tmpDir2, 'docs')
    mkdirSync(docsDir2)
    writeFileSync(join(docsDir2, 'seed-capsule-tianfu.md'), [
      '<seed-capsule star="天府" sealed="2026-06-02">',
      '  second.',
      '</seed-capsule>',
    ].join('\n'))

    const first = loadAllCapsules(tmpDir)
    const second = loadAllCapsules(tmpDir2)
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal(first[0]!.star, '天璇')
    assert.equal(second[0]!.star, '天府')

    cleanup()
    try { rmSync(tmpDir2, { recursive: true }) } catch { /* ignore */ }
  })

  it('clearCapsuleCache forces reload', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  v1.',
      '</seed-capsule>',
    ].join('\n'))

    const first = loadAllCapsules(tmpDir)
    assert.equal(first[0]!.raw, 'v1.')

    // Overwrite file
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  v2.',
      '</seed-capsule>',
    ].join('\n'))

    // Still cached
    const cached = loadAllCapsules(tmpDir)
    assert.equal(cached[0]!.raw, 'v1.')

    // Clear cache → reload
    clearCapsuleCache()
    const reloaded = loadAllCapsules(tmpDir)
    assert.equal(reloaded[0]!.raw, 'v2.')
    cleanup()
  })
})

describe('renderAllCapsulesBlock', () => {
  let tmpDir: string

  beforeEach(() => {
    clearCapsuleCache()
    tmpDir = mkdtempSync(join(os.tmpdir(), 'capsule-render-'))
  })

  function cleanup() {
    try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  }

  it('returns undefined when no capsules', () => {
    const block = renderAllCapsulesBlock(tmpDir)
    assert.equal(block, undefined)
    cleanup()
  })

  it('returns merged block for multiple capsules', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  天璇方法',
      '</seed-capsule>',
    ].join('\n'))
    writeFileSync(join(docsDir, 'seed-capsule-tianfu.md'), [
      '<seed-capsule star="天府" sealed="2026-06-02">',
      '  天府方法',
      '</seed-capsule>',
    ].join('\n'))

    const block = renderAllCapsulesBlock(tmpDir)
    assert.ok(block)
    assert.ok(block!.includes('star="天璇"'))
    assert.ok(block!.includes('star="天府"'))
    assert.ok(block!.includes('天璇方法'))
    assert.ok(block!.includes('天府方法'))
    // 天璇 comes first (earlier sealed date)
    assert.ok(block!.indexOf('天璇') < block!.indexOf('天府'))
    cleanup()
  })

  it('escapes XML special characters in capsule content', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-test.md'), [
      '<seed-capsule star="测试" sealed="2026-01-01">',
      '  content with <tags> & "quotes"',
      '</seed-capsule>',
    ].join('\n'))

    const block = renderAllCapsulesBlock(tmpDir)
    assert.ok(block)
    // raw content should have XML-escaped characters in the block
    assert.ok(block!.includes('&lt;tags&gt;'))
    assert.ok(block!.includes('&amp;'))
    assert.ok(block!.includes('&quot;'))
    cleanup()
  })
})
