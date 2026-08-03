import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PrewarmController, type PrewarmDeps } from '../prewarm-controller.js'
import { PrewarmCache } from '../prewarm.js'
import { buildPrewarmValue } from '../prewarm-file.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prewarm-controller-'))
})

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

function makeController(overrides: Partial<PrewarmDeps> = {}): { controller: PrewarmController; cache: PrewarmCache } {
  const cache = new PrewarmCache(60_000, 50)
  const deps: PrewarmDeps = {
    getCwd: () => dir,
    getPrewarmCache: () => cache,
    getRecentToolHistory: () => [],
    ...overrides,
  }
  return { controller: new PrewarmController(deps), cache }
}

function historyOf(...targets: string[]): ToolHistoryEntry[] {
  return targets.map(target => ({ tool: 'read_file', target, status: 'success' }))
}

describe('PrewarmController — physarum 预测注入', () => {
  it('预测注入 top-3（k=3 硬上限）', async () => {
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `p${i}.ts`), `export const p${i} = ${i}\n`)
    const { controller, cache } = makeController({
      getPhysarumPredictions: () => [1, 2, 3, 4, 5].map(i => ({ file: `p${i}.ts`, score: 6 - i })),
    })

    await controller.prewarmRecentReads()

    assert.ok(cache.has(join(dir, 'p1.ts')))
    assert.ok(cache.has(join(dir, 'p2.ts')))
    assert.ok(cache.has(join(dir, 'p3.ts')))
    assert.equal(cache.has(join(dir, 'p4.ts')), false, '第 4 条预测不得注入')
    assert.equal(cache.has(join(dir, 'p5.ts')), false, '第 5 条预测不得注入')
  })

  it('与已有缓存去重——已存在的条目不被覆写', async () => {
    for (let i = 1; i <= 3; i++) writeFileSync(join(dir, `p${i}.ts`), `export const p${i} = ${i}\n`)
    const { controller, cache } = makeController({
      getPhysarumPredictions: () => [
        { file: 'p1.ts', score: 3 },
        { file: 'p2.ts', score: 2 },
        { file: 'p3.ts', score: 1 },
      ],
    })
    const existing = await buildPrewarmValue(dir, 'p1.ts')
    assert.ok(existing)
    cache.set(existing.canonicalPath, { ...existing, content: 'MARKER' })

    await controller.prewarmRecentReads()

    assert.equal(cache.get(existing.canonicalPath)?.content, 'MARKER', '已有条目不得被预测覆写')
    assert.ok(cache.has(join(dir, 'p2.ts')))
    assert.ok(cache.has(join(dir, 'p3.ts')))
  })

  it('dep 缺席时零行为', async () => {
    const { controller, cache } = makeController()

    await controller.prewarmRecentReads()

    const stats = cache.stats()
    assert.equal(stats.hits, 0)
    assert.equal(stats.misses, 0)
  })

  it('predictNext 抛错时静默降级，recent-reads 路径不受影响', async () => {
    writeFileSync(join(dir, 'r.ts'), 'export const r = 1\n')
    const { controller, cache } = makeController({
      getRecentToolHistory: () => historyOf('r.ts'),
      getPhysarumPredictions: () => { throw new Error('boom') },
    })

    await controller.prewarmRecentReads()

    assert.ok(cache.has(join(dir, 'r.ts')), '最近读取的文件仍应预热')
  })
})
