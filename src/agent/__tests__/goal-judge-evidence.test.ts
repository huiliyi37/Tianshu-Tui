import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MeridianDb } from '../../repo/meridian-db.js'
import { appendMeridianBlastRadius } from '../loop-factory.js'

/** Minimal mock satisfying the structural surface analyzeImpact touches. */
function mockDb(opts: {
  reverse?: Record<string, Array<{ file: string; kind: string; weight: number }>>
  tests?: Record<string, string[]>
  coEdit?: Record<string, Array<{ file: string; weight: number }>>
} = {}): MeridianDb {
  return {
    getReverseDependents: (f: string) => opts.reverse?.[f] ?? [],
    getTestsFor: (f: string) => opts.tests?.[f] ?? [],
    getCoEditNeighbors: (f: string) => opts.coEdit?.[f] ?? [],
  } as unknown as MeridianDb
}

describe('appendMeridianBlastRadius', () => {
  it('returns text unchanged when db is null/undefined', () => {
    const text = 'Modified files: a.ts'
    assert.equal(appendMeridianBlastRadius(text, ['a.ts'], null), text)
    assert.equal(appendMeridianBlastRadius(text, ['a.ts'], undefined), text)
  })

  it('returns text unchanged when all files are absolute paths', () => {
    const text = 'Modified files: /abs/a.ts'
    const db = mockDb({ reverse: { '/abs/a.ts': [{ file: 'b.ts', kind: 'import', weight: 1 }] } })
    // Absolute path filtered → no impact query → text unchanged
    const result = appendMeridianBlastRadius(text, ['/abs/a.ts'], db)
    assert.equal(result, text)
  })

  it('appends blast radius when db has reverse dependents', () => {
    const text = 'Modified files: src/foo.ts'
    const db = mockDb({
      reverse: { 'src/foo.ts': [{ file: 'src/bar.ts', kind: 'import', weight: 1 }] },
      tests: { 'src/foo.ts': ['src/__tests__/foo.test.ts'] },
    })
    const result = appendMeridianBlastRadius(text, ['src/foo.ts'], db)
    assert.match(result, /Meridian blast radius/)
    assert.match(result, /Direct consumers.*src\/bar\.ts/)
    assert.match(result, /Related tests.*src\/__tests__\/foo\.test\.ts/)
  })

  it('filters absolute paths but still queries relative ones', () => {
    const text = 'Modified files: /abs/x.ts, src/foo.ts'
    const db = mockDb({
      reverse: { 'src/foo.ts': [{ file: 'src/bar.ts', kind: 'import', weight: 1 }] },
    })
    const result = appendMeridianBlastRadius(text, ['/abs/x.ts', 'src/foo.ts'], db)
    assert.match(result, /Meridian blast radius/)
    assert.match(result, /src\/bar\.ts/)
  })

  it('returns text unchanged when impact is empty (no consumers, no tests)', () => {
    const text = 'Modified files: src/orphan.ts'
    const db = mockDb() // no edges
    const result = appendMeridianBlastRadius(text, ['src/orphan.ts'], db)
    assert.equal(result, text)
  })

  it('caps consumer list at 10 with (+N more)', () => {
    const text = 'Modified files: src/hub.ts'
    const deps = Array.from({ length: 15 }, (_, i) => ({ file: `src/dep${i}.ts`, kind: 'import', weight: 1 }))
    const db = mockDb({ reverse: { 'src/hub.ts': deps } })
    const result = appendMeridianBlastRadius(text, ['src/hub.ts'], db)
    assert.match(result, /\(\+5 more\)/)
  })
})
