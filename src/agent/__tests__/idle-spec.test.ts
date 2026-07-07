import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IdleSpec } from '../idle-spec.js'

describe('IdleSpec', () => {
  function createMockDeps() {
    const enqueued: Array<{tool: string; probability: number; likelyTarget?: string}> = []
    const cache = new Map<string, string>()
    return {
      miner: {
        predict(fromTool: string, _threshold?: number) {
          if (fromTool === 'grep') {
            return [{ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' }]
          }
          return []
        },
      },
      queue: {
        enqueue(p: {tool: string; probability: number; likelyTarget?: string}) {
          enqueued.push(p)
          if (p.likelyTarget) cache.set(`${p.tool}:${p.likelyTarget}`, 'cached-content')
        },
        checkHit(tool: string, target: string) {
          return cache.get(`${tool}:${target}`)
        },
      },
      enqueued,
    }
  }

  it('enqueues predictions on tool start', () => {
    const deps = createMockDeps()
    const spec = new IdleSpec(deps)
    spec.onToolStart('grep')
    assert.equal(deps.enqueued.length, 1)
    assert.equal(deps.enqueued[0]!.tool, 'read_file')
  })

  it('does nothing for tools with no predictions', () => {
    const deps = createMockDeps()
    const spec = new IdleSpec(deps)
    spec.onToolStart('unknown_tool')
    assert.equal(deps.enqueued.length, 0)
  })

  it('returns cached result on hit', () => {
    const deps = createMockDeps()
    const spec = new IdleSpec(deps)
    spec.onToolStart('grep')
    const result = spec.checkCache('read_file', 'src/foo.ts')
    assert.equal(result, 'cached-content')
  })

  it('returns undefined on miss', () => {
    const deps = createMockDeps()
    const spec = new IdleSpec(deps)
    spec.onToolStart('grep')
    const result = spec.checkCache('edit_file', 'src/bar.ts')
    assert.equal(result, undefined)
  })

  it('tracks speculation stats', () => {
    const deps = createMockDeps()
    const spec = new IdleSpec(deps)
    spec.onToolStart('grep')
    spec.checkCache('read_file', 'src/foo.ts')  // hit
    spec.checkCache('edit_file', 'src/x.ts')     // miss
    const s = spec.stats()
    assert.equal(s.speculations, 1)
    assert.equal(s.hits, 1)
    assert.equal(s.misses, 1)
  })
})
