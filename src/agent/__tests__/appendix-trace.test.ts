import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { appendixBlockNames, appendixTraceEnabled, buildAppendixTraceEntry, recordAppendixTrace } from '../appendix-trace.js'

const APPENDIX = [
  '<git-status>\nM src/foo.ts\n</git-status>',
  '<progress>\ncurrent: fix cache\ndone: read docs\n</progress>',
  '<cognitive-mirror stability="mid:partial" />',
].join('\n\n')

describe('appendix trace block names', () => {
  it('lists top-level blocks in render order', () => {
    assert.deepEqual(appendixBlockNames(APPENDIX), ['git-status', 'progress', 'cognitive-mirror'])
  })

  it('ignores nested and inline tags — only line-leading blocks count', () => {
    const nested = '<progress>\ncurrent: read <objective>x</objective>\n</progress>'
    assert.deepEqual(appendixBlockNames(nested), ['progress'])
  })

  it('returns nothing for text with no blocks', () => {
    assert.deepEqual(appendixBlockNames('just prose'), [])
  })
})

describe('appendix trace entry', () => {
  it('records the rendered text verbatim alongside its size', () => {
    const entry = buildAppendixTraceEntry(APPENDIX, { turn: 4, model: 'test-model', now: 1000 })
    assert.equal(entry.event, 'appendix_render')
    assert.equal(entry.turn, 4)
    assert.equal(entry.model, 'test-model')
    assert.equal(entry.t, 1000)
    assert.equal(entry.content, APPENDIX, 'content must be verbatim — a summary cannot answer "what did the model see"')
    assert.equal(entry.bytes, Buffer.byteLength(APPENDIX))
  })

  it('measures bytes, not chars — CJK blocks would otherwise read short', () => {
    const cjk = '<progress>\ncurrent: 修缓存\n</progress>'
    assert.ok(buildAppendixTraceEntry(cjk, { turn: 1 }).bytes > cjk.length)
  })
})

describe('appendix trace sink', () => {
  let dir: string
  const prev = process.env.RIVET_APPENDIX_TRACE
  const prevSessionDir = process.env.RIVET_SESSION_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'appendix-trace-'))
    process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.RIVET_APPENDIX_TRACE
    else process.env.RIVET_APPENDIX_TRACE = prev
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('is off unless explicitly enabled', () => {
    delete process.env.RIVET_APPENDIX_TRACE
    assert.equal(appendixTraceEnabled(), false)
    recordAppendixTrace(APPENDIX, { cwd: dir, sessionId: 's1', turn: 1 })
    assert.equal(existsSync(join(process.env.RIVET_SESSION_DIR!, 's1', 'appendix-trace.jsonl')), false)
  })

  it('writes one JSONL line per render when enabled', async () => {
    process.env.RIVET_APPENDIX_TRACE = '1'
    recordAppendixTrace(APPENDIX, { cwd: dir, sessionId: 's1', turn: 1, model: 'm' })
    recordAppendixTrace(APPENDIX, { cwd: dir, sessionId: 's1', turn: 2, model: 'm' })

    const file = join(process.env.RIVET_SESSION_DIR!, 's1', 'appendix-trace.jsonl')
    for (let i = 0; i < 50 && !existsSync(file); i++) await delay(10)
    // The append is fire-and-forget; give the second line a moment to land too.
    let lines: string[] = []
    for (let i = 0; i < 50; i++) {
      lines = readFileSync(file, 'utf8').trim().split('\n')
      if (lines.length >= 2) break
      await delay(10)
    }

    assert.equal(lines.length, 2)
    const parsed = lines.map(l => JSON.parse(l))
    // 落盘是 fire-and-forget 的并发 append（见上），行序无保证——按 turn 取记录，
    // 不按行序断言：本用例要证的是「每次渲染落一行且内容逐字保真」，不是排序。
    assert.deepEqual(parsed.map(p => p.turn).sort((a, b) => a - b), [1, 2])
    const first = parsed.find(p => p.turn === 1)
    assert.ok(first, 'turn 1 的记录必须落盘')
    assert.equal(first.content, APPENDIX)
    assert.deepEqual(first.blocks, ['git-status', 'progress', 'cognitive-mirror'])
  })

  it('skips an absent appendix rather than writing an empty record', () => {
    process.env.RIVET_APPENDIX_TRACE = '1'
    recordAppendixTrace(undefined, { cwd: dir, sessionId: 's1', turn: 1 })
    assert.equal(existsSync(join(process.env.RIVET_SESSION_DIR!, 's1', 'appendix-trace.jsonl')), false)
  })
})
