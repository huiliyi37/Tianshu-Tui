import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdvisoryEfficacyStore, type EfficacyDelta } from '../advisory-efficacy-store.js'

const DAY = 24 * 60 * 60 * 1000

function delta(overrides: Partial<EfficacyDelta> = {}): EfficacyDelta {
  return { delivered: 0, adopted: 0, ignored: 0, shadowHeld: 0, shadowSatisfied: 0, ...overrides }
}

describe('AdvisoryEfficacyStore', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'efficacy-')) })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  test('空文件加载为空 Map;mergeAndSave 后 load 回读', () => {
    const store = new AdvisoryEfficacyStore(cwd)
    assert.equal(store.load().size, 0)
    const now = Date.now()
    store.mergeAndSave(new Map([['k1', delta({ delivered: 3, adopted: 2, ignored: 1 })]]), now)
    const loaded = store.load(now)
    const p = loaded.get('k1')!
    assert.equal(p.delivered, 3)
    assert.equal(p.adopted, 2)
    assert.equal(p.ignored, 1)
  })

  test('EWMA 衰减:14 天半衰期,28 天后计数约 1/4', () => {
    const store = new AdvisoryEfficacyStore(cwd)
    const t0 = Date.now()
    store.mergeAndSave(new Map([['k', delta({ delivered: 8, adopted: 4 })]]), t0)
    const loaded = store.load(t0 + 28 * DAY)
    const p = loaded.get('k')!
    assert.ok(Math.abs(p.delivered - 2) < 0.01, `delivered≈2,实际 ${p.delivered}`)
    assert.ok(Math.abs(p.adopted - 1) < 0.01, `adopted≈1,实际 ${p.adopted}`)
  })

  test('增量合并:两次 mergeAndSave 叠加而非覆盖', () => {
    const store = new AdvisoryEfficacyStore(cwd)
    const now = Date.now()
    store.mergeAndSave(new Map([['k', delta({ delivered: 2, adopted: 1 })]]), now)
    store.mergeAndSave(new Map([['k', delta({ delivered: 1, adopted: 1 })]]), now)
    const p = store.load(now).get('k')!
    assert.equal(p.delivered, 3)
    assert.equal(p.adopted, 2)
  })

  test('衰减殆尽的 key 在写回时剔除;load 也过滤', () => {
    const store = new AdvisoryEfficacyStore(cwd)
    const t0 = Date.now()
    store.mergeAndSave(new Map([['old', delta({ delivered: 1 })]]), t0)
    // 200 天后:0.5^(200/14) ≈ 5e-5 < PRUNE_THRESHOLD
    const later = t0 + 200 * DAY
    assert.equal(store.load(later).has('old'), false)
    store.mergeAndSave(new Map([['fresh', delta({ delivered: 1 })]]), later)
    const raw = readFileSync(join(cwd, '.rivet', 'knowledge', 'advisory-efficacy.jsonl'), 'utf-8')
    assert.ok(!raw.includes('"old"'), '衰减殆尽的 key 应被剔除')
    assert.ok(raw.includes('"fresh"'))
  })

  test('零增量不落盘(文件不创建)', () => {
    const store = new AdvisoryEfficacyStore(cwd)
    store.mergeAndSave(new Map([['k', delta()]]))
    assert.equal(existsSync(join(cwd, '.rivet', 'knowledge', 'advisory-efficacy.jsonl')), false)
  })

  test('损坏行跳过不炸', () => {
    const dir = join(cwd, '.rivet', 'knowledge')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    writeFileSync(join(dir, 'advisory-efficacy.jsonl'),
      `not-json\n${JSON.stringify({ key: 'ok', delivered: 2, adopted: 1, ignored: 0, shadowHeld: 0, shadowSatisfied: 0, updatedAt: now })}\n{"key":123}\n`, 'utf-8')
    const store = new AdvisoryEfficacyStore(cwd)
    const loaded = store.load(now)
    assert.equal(loaded.size, 1)
    assert.equal(loaded.get('ok')!.delivered, 2)
  })

  test('并发写不丢账(锁串行化):两个 store 实例各写一个 key', () => {
    const a = new AdvisoryEfficacyStore(cwd)
    const b = new AdvisoryEfficacyStore(cwd)
    const now = Date.now()
    a.mergeAndSave(new Map([['ka', delta({ delivered: 1 })]]), now)
    b.mergeAndSave(new Map([['kb', delta({ delivered: 1 })]]), now)
    const loaded = a.load(now)
    assert.ok(loaded.has('ka') && loaded.has('kb'))
  })
})
