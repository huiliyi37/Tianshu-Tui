import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectMistakeResolution, sanitizeMistakeResolutionInput } from '../mistake-detector.js'
import { createTraceStore, recordTraceEvent } from '../trace-store.js'
import type { TraceStore } from '../trace-store.js'

function addEvent(store: TraceStore, id: string, name: string, status: 'passed' | 'failed', summary: string, turn = 0): TraceStore {
  return recordTraceEvent(store, {
    id, turn, kind: 'tool', name, status,
    startedAt: Date.now(), endedAt: Date.now(), summary,
  })
}

describe('detectMistakeResolution', () => {
  it('returns null when no prior failed event for same tool', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'passed', 'ok', 1)
    const result = detectMistakeResolution(store, 'a', 'bash')
    assert.equal(result, null)
  })

  it('returns null when current event is failed (not a resolution)', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'err1', 1)
    store = addEvent(store, 'b', 'bash', 'failed', 'err2', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.equal(result, null)
  })

  it('returns mistake when current passed follows a failed of same tool', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'tsc TS2322 type mismatch', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.ok(result)
    assert.match(result.error, /TS2322/)
  })

  it('ignores failed events of other tools', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'edit_file', 'failed', 'edit failed', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.equal(result, null)
  })

  it('skips when an intervening passed already resolved the failure', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'old err', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2) // already resolved
    store = addEvent(store, 'c', 'bash', 'passed', 'ok again', 3)
    const result = detectMistakeResolution(store, 'c', 'bash')
    assert.equal(result, null, 'no new mistake to learn — already resolved at b')
  })

  it('finds the most recent failed when multiple exist', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'old err A', 1)
    store = addEvent(store, 'b', 'bash', 'failed', 'recent err B', 2)
    store = addEvent(store, 'c', 'bash', 'passed', 'ok', 3)
    const result = detectMistakeResolution(store, 'c', 'bash')
    assert.ok(result)
    assert.match(result.error, /recent err B/)
  })

  it('returns null when traceId not found in store', () => {
    const store = createTraceStore()
    const result = detectMistakeResolution(store, 'missing', 'bash')
    assert.equal(result, null)
  })
})

// File-state-specific params must not be replayed as reusable "resolutions"
// in <mistake-hints> — they are one-shot coordinates dead after any file change
// (2026-07-06 TDX loop: replayed hash_edit anchors).
describe('sanitizeMistakeResolutionInput', () => {
  it('strips hash_edit anchors, keeps the rest of the shape', () => {
    const input = { file_path: 'a.ts', anchors: ['L3:deadbeef'], new_string: 'x' }
    const out = sanitizeMistakeResolutionInput('hash_edit', input)
    assert.equal(out.anchors, '<one-shot, re-harvest via grep>')
    assert.equal(out.file_path, 'a.ts')
    assert.equal(out.new_string, 'x')
    assert.deepEqual(input.anchors, ['L3:deadbeef'], 'original input must not be mutated')
  })

  it('strips edit_file old_string, keeps new_string (desired content, not a coordinate)', () => {
    const input = { file_path: 'a.ts', old_string: 'const x = 1', new_string: 'const x = 2' }
    const out = sanitizeMistakeResolutionInput('edit_file', input)
    assert.equal(out.old_string, '<file-state-specific, re-match against current content>')
    assert.equal(out.new_string, 'const x = 2')
    assert.equal(input.old_string, 'const x = 1', 'original input must not be mutated')
  })

  it('strips apply_patch diff (context lines are positional anchors)', () => {
    const input = { diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new', check_only: false }
    const out = sanitizeMistakeResolutionInput('apply_patch', input)
    assert.equal(out.diff, '<file-state-specific patch, regenerate from current content>')
    assert.equal(out.check_only, false)
  })

  it('leaves ast_edit untouched — structural patterns are reusable, not coordinates', () => {
    const input = { ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }] }
    const out = sanitizeMistakeResolutionInput('ast_edit', input)
    assert.deepEqual(out, input)
  })

  it('passes through unrelated tools and inputs missing the target field', () => {
    const bash = { command: 'npm test' }
    assert.deepEqual(sanitizeMistakeResolutionInput('bash', bash), bash)
    const editNoOld = { file_path: 'a.ts', new_string: 'x' }
    assert.deepEqual(sanitizeMistakeResolutionInput('edit_file', editNoOld), editNoOld)
  })
})
