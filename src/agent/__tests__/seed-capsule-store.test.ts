import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import {
  loadAllCapsules,
  collectCapsules,
  renderAllCapsulesBlock,
  renderCapsuleIndexBlock,
  renderResidentCapsuleBlock,
  getCapsuleByStar,
  listCapsuleStars,
  clearCapsuleCache,
  extractPrinciples,
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

  it('multi-slot cache: alternating cwds do not evict each other (no thrash)', () => {
    const docsDir1 = join(tmpDir, 'docs')
    mkdirSync(docsDir1)
    writeFileSync(join(docsDir1, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  cwd1.',
      '</seed-capsule>',
    ].join('\n'))

    const tmpDir2 = mkdtempSync(join(os.tmpdir(), 'capsule-test3-'))
    const docsDir2 = join(tmpDir2, 'docs')
    mkdirSync(docsDir2)
    writeFileSync(join(docsDir2, 'seed-capsule-tianfu.md'), [
      '<seed-capsule star="天府" sealed="2026-06-02">',
      '  cwd2.',
      '</seed-capsule>',
    ].join('\n'))

    const a1 = loadAllCapsules(tmpDir)
    loadAllCapsules(tmpDir2) // single-slot cache would have evicted cwd1 here
    const a2 = loadAllCapsules(tmpDir)
    // Map cache keeps cwd1's entry → same reference, no reload (no thrash).
    assert.strictEqual(a1, a2)

    cleanup()
    try { rmSync(tmpDir2, { recursive: true }) } catch { /* ignore */ }
  })

  // ── 多来源合并（内置 dist/seed-capsules + 项目 docs/）──────────
  // collectCapsules 是 loadAllCapsules 的纯函数内核：靠后目录按文件名覆盖靠前。

  it('collectCapsules merges dirs; later dir overrides same-named file', () => {
    const bundled = mkdtempSync(join(os.tmpdir(), 'capsule-bundled-'))
    const project = mkdtempSync(join(os.tmpdir(), 'capsule-project-'))
    // 内置：两条胶囊
    writeFileSync(join(bundled, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">', '  内置天璇 v1.', '</seed-capsule>',
    ].join('\n'))
    writeFileSync(join(bundled, 'seed-capsule-tianfu.md'), [
      '<seed-capsule star="天府" sealed="2026-06-02">', '  内置天府.', '</seed-capsule>',
    ].join('\n'))
    // 项目：覆盖同名 tianxuan，另加一条独有
    writeFileSync(join(project, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">', '  项目天璇 v2.', '</seed-capsule>',
    ].join('\n'))
    writeFileSync(join(project, 'seed-capsule-yaoguang.md'), [
      '<seed-capsule star="瑶光" sealed="2026-06-07">', '  项目瑶光.', '</seed-capsule>',
    ].join('\n'))

    const merged = collectCapsules([bundled, project])
    // 3 条：天璇(项目覆盖内置) + 天府(内置独有) + 瑶光(项目独有)
    assert.equal(merged.length, 3)
    const tx = merged.find(c => c.star === '天璇')!
    assert.equal(tx.raw, '项目天璇 v2.', '项目同名文件覆盖内置')
    assert.ok(merged.some(c => c.star === '天府'), '内置独有胶囊保留')
    assert.ok(merged.some(c => c.star === '瑶光'), '项目独有胶囊保留')
    // sealedAt 排序：天璇(05-21) < 天府(06-02) < 瑶光(06-07)
    assert.deepEqual(merged.map(c => c.star), ['天璇', '天府', '瑶光'])

    try { rmSync(bundled, { recursive: true }) } catch { /* ignore */ }
    try { rmSync(project, { recursive: true }) } catch { /* ignore */ }
  })

  it('collectCapsules skips missing dirs', () => {
    const merged = collectCapsules([join(tmpDir, 'nope'), join(tmpDir, 'also-nope')])
    assert.deepEqual(merged, [])
    cleanup()
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

  it('renderResidentCapsuleBlock delegates to capsule index (no guardrails — moved to static.ts rules)', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-tianxuan.md'), [
      '<seed-capsule star="天璇" sealed="2026-05-21">',
      '  天璇方法',
      '</seed-capsule>',
    ].join('\n'))

    const block = renderResidentCapsuleBlock(tmpDir)
    assert.ok(block)
    // After 943414c2: resident block = capsule index with recall path, no guardrails inline
    assert.ok(block!.includes('recall_capsule'))
    assert.ok(block!.includes('天璇'))
    // Guidance line for when to invoke recall_capsule
    assert.ok(block!.includes('调用 recall_capsule'))
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

  // ── 多属性容错 + gist 提取（瑶光在自封胶囊时亲历的"多属性静默丢弃"族回归） ──

  it('tolerates extra tag attributes and does NOT silently drop the capsule', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    // 额外的 seal / gist 属性夹在 sealed 与 > 之间——旧正则会整块丢弃。
    writeFileSync(join(docsDir, 'seed-capsule-yaoguang.md'), [
      '<seed-capsule star="瑶光" sealed="2026-06-07" seal="7·48·↻" gist="验证/复现纪律">',
      '  绿非证明，复现即证。',
      '</seed-capsule>',
    ].join('\n'))

    const capsules = loadAllCapsules(tmpDir)
    assert.equal(capsules.length, 1, '多属性标签必须仍被加载，不得静默丢弃')
    assert.equal(capsules[0]!.star, '瑶光')
    assert.equal(capsules[0]!.gist, '验证/复现纪律', 'gist 属性应被提取')
    cleanup()
  })

  it('attribute order does not matter for star/sealed', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-x.md'), [
      '<seed-capsule sealed="2026-01-01" gist="g" star="测试">',
      '  内容',
      '</seed-capsule>',
    ].join('\n'))

    const capsules = loadAllCapsules(tmpDir)
    assert.equal(capsules.length, 1)
    assert.equal(capsules[0]!.star, '测试')
    assert.equal(capsules[0]!.sealedAt, '2026-01-01')
    cleanup()
  })

  it('renderCapsuleIndexBlock emits one line per star, far smaller than full', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-a.md'), [
      '<seed-capsule star="甲" sealed="2026-01-01" gist="甲之道">',
      '  '.padEnd(500, '长'),
      '</seed-capsule>',
    ].join('\n'))
    writeFileSync(join(docsDir, 'seed-capsule-b.md'), [
      '<seed-capsule star="乙" sealed="2026-01-02" gist="乙之道">',
      '  '.padEnd(500, '长'),
      '</seed-capsule>',
    ].join('\n'))

    const idx = renderCapsuleIndexBlock(tmpDir)!
    const full = renderAllCapsulesBlock(tmpDir)!
    assert.ok(idx.includes('甲 — 甲之道'))
    assert.ok(idx.includes('乙 — 乙之道'))
    assert.ok(idx.includes('recall_capsule'))
    assert.ok(idx.length < full.length / 2, '索引必须远小于全文注入')
    cleanup()
  })

  // C1（天梁最大化）：十域交付主力的胶囊真实存在且可被发现/提取。
  it('repo docs/ ships a 天梁 capsule with L1-L6 principles (C1)', () => {
    clearCapsuleCache()
    const repoRoot = process.cwd()
    const capsule = getCapsuleByStar(repoRoot, '天梁')
    assert.ok(capsule, 'docs/seed-capsule-tianliang.md 必须存在且可解析')
    assert.ok(capsule!.gist, '天梁胶囊必须带 gist 一行索引')
    const principles = extractPrinciples(repoRoot, '天梁')
    assert.ok(principles, '天梁胶囊应含 <principle> 标签')
    assert.deepEqual(principles!.map(p => p.key), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])
    for (const p of principles!) {
      assert.ok(p.maxim.length > 0)
      assert.ok(p.actionPrompt.length > 0)
    }
    clearCapsuleCache()
  })

  // B4：贪狼胶囊的 7 条方法带 principle 标签，动态原则池对贪狼生效。
  it('repo docs/ 贪狼 capsule carries T1-T7 principles (B4)', () => {
    clearCapsuleCache()
    const repoRoot = process.cwd()
    const capsule = getCapsuleByStar(repoRoot, '贪狼')
    assert.ok(capsule, 'docs/seed-capsule-tanlang.md 必须存在且可解析')
    const principles = extractPrinciples(repoRoot, '贪狼')
    assert.ok(principles, '贪狼胶囊应含 <principle> 标签')
    assert.deepEqual(principles!.map(p => p.key), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'])
    for (const p of principles!) {
      assert.ok(p.maxim.length > 0)
      assert.ok(p.actionPrompt.length > 0)
    }
    clearCapsuleCache()
  })

  it('getCapsuleByStar fetches one capsule by name (trim + case insensitive)', () => {
    const docsDir = join(tmpDir, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, 'seed-capsule-t.md'), [
      '<seed-capsule star="天权" sealed="2026-06-03">',
      '  称量之道',
      '</seed-capsule>',
    ].join('\n'))

    assert.equal(getCapsuleByStar(tmpDir, '  天权  ')!.star, '天权')
    assert.equal(getCapsuleByStar(tmpDir, '破军'), undefined)
    assert.deepEqual(listCapsuleStars(tmpDir), ['天权'])
    cleanup()
  })
})
