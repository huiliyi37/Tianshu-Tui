import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlaybookStore, playbookPathForCwd } from '../playbook-store.js'
import type { PlaybookBullet } from '../playbook.js'

function bullet(id: string, overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id,
    createdAt: 1_000,
    keywords: ['agent', id],
    lesson: `lesson ${id}`,
    context: `context ${id}`,
    useCount: 0,
    lastUsedAt: null,
    importance: 0.5,
    ...overrides,
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-playbook-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('PlaybookStore', () => {
  it('uses .rivet/playbook.jsonl under cwd by default', () => {
    withTempDir((dir) => {
      assert.equal(playbookPathForCwd(dir), join(dir, '.rivet', 'playbook.jsonl'))
    })
  })

  it('saves and loads bullets as JSONL', () => {
    withTempDir((dir) => {
      const store = new PlaybookStore(dir)
      store.save([bullet('a'), bullet('b')])

      const raw = readFileSync(playbookPathForCwd(dir), 'utf-8')
      assert.equal(raw.trim().split('\n').length, 2)
      assert.deepEqual(store.load().map(b => b.id), ['a', 'b'])
    })
  })

  it('ignores malformed lines and invalid bullets when loading', () => {
    withTempDir((dir) => {
      const path = playbookPathForCwd(dir)
      mkdirSync(join(dir, '.rivet'), { recursive: true })
      writeFileSync(path, `${JSON.stringify(bullet('ok'))}\nnot json\n${JSON.stringify({ id: 'bad' })}\n`, 'utf-8')
      const store = new PlaybookStore(dir)

      assert.deepEqual(store.load().map(b => b.id), ['ok'])
    })
  })

  it('adds bullets with dedupe, decay, and capacity enforcement', () => {
    withTempDir((dir) => {
      const store = new PlaybookStore(dir, { capacity: 2, now: () => 20_000 })
      store.save([
        bullet('existing', { keywords: ['tests', 'verification'], lesson: 'Run tests after edits', importance: 0.4 }),
        bullet('keep', { keywords: ['dead-end'], lesson: 'Avoid known dead-end path', importance: 0.01 }),
      ])

      store.addBullets([
        bullet('incoming', { keywords: ['tests', 'verification', 'coverage'], lesson: 'Run tests after edits', importance: 0.7 }),
        bullet('new', { keywords: ['api'], lesson: 'Check API schema drift', importance: 0.8 }),
      ])

      const loaded = store.load()
      assert.equal(loaded.length, 2)
      assert.ok(loaded.some(b => b.id === 'keep'))
      assert.ok(loaded.some(b => b.id === 'existing' || b.id === 'new'))
    })
  })

  it('queries matching bullets and persists usage metadata', () => {
    withTempDir((dir) => {
      const store = new PlaybookStore(dir, { now: () => 50_000 })
      store.save([
        bullet('miss', { keywords: ['api'], importance: 0.9 }),
        bullet('hit', { keywords: ['tests', 'agent'], importance: 0.4 }),
      ])

      const result = store.query(['tests'], 1)

      assert.deepEqual(result.map(b => b.id), ['hit'])
      const loaded = store.load()
      assert.equal(loaded.find(b => b.id === 'hit')!.useCount, 1)
      assert.equal(loaded.find(b => b.id === 'hit')!.lastUsedAt, 50_000)
    })
  })

  it('records usage for explicit ids', () => {
    withTempDir((dir) => {
      const store = new PlaybookStore(dir, { now: () => 60_000 })
      store.save([bullet('a'), bullet('b')])

      store.recordUsage(['a', 'missing'])

      const loaded = store.load()
      assert.equal(loaded.find(b => b.id === 'a')!.useCount, 1)
      assert.equal(loaded.find(b => b.id === 'a')!.lastUsedAt, 60_000)
      assert.equal(loaded.find(b => b.id === 'b')!.useCount, 0)
    })
  })
})
