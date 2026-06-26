/**
 * Worker session persistence tests — save/load round-trip for resume support.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveWorkerSession,
  loadWorkerSession,
  workerSessionPath,
  type WorkerSessionRecord,
} from '../worker-session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('worker-session-persist', () => {
  function makeMessages(): OaiMessage[] {
    return [
      { role: 'system', content: 'You are a worker.' },
      { role: 'user', content: 'Find the auth flow.' },
      { role: 'assistant', content: 'I found it.', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"auth"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'auth.ts:1:export function authenticate' },
      { role: 'assistant', content: '{"workOrderId":"wo_test","status":"passed","summary":"found auth flow"}' },
    ]
  }

  it('save → load round-trips messages', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const id = 'wo_roundtrip'
    const msgs = makeMessages()
    saveWorkerSession(id, 'code_scout', 'Find the auth flow.', msgs, home)

    const loaded = loadWorkerSession(id, home)
    assert.ok(loaded, 'should load the saved record')
    assert.equal(loaded!.workOrderId, id)
    assert.equal(loaded!.profile, 'code_scout')
    assert.equal(loaded!.objective, 'Find the auth flow.')
    assert.equal(loaded!.messages.length, 5)
    assert.equal(loaded!.messages[0]!.role, 'system')
    assert.equal(loaded!.messages[1]!.role, 'user')
    assert.equal(loaded!.messages[2]!.role, 'assistant')
    assert.ok(loaded!.savedAt > 0)
  })

  it('returns null when the file does not exist (cold miss, no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const loaded = loadWorkerSession('nonexistent', home)
    assert.equal(loaded, null)
  })

  it('returns null for corrupt JSON (no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wo_bad.session.jsonl'), 'not json at all', 'utf-8')
    const loaded = loadWorkerSession('wo_bad', home)
    assert.equal(loaded, null)
  })

  it('returns null for an empty file', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wo_empty.session.jsonl'), '   \n  ', 'utf-8')
    const loaded = loadWorkerSession('wo_empty', home)
    assert.equal(loaded, null)
  })

  it('can save and load an empty messages array', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    saveWorkerSession('wo_empty_msgs', 'code_scout', 'test', [], home)
    const loaded = loadWorkerSession('wo_empty_msgs', home)
    assert.ok(loaded)
    assert.deepEqual(loaded!.messages, [])
  })

  it('creates the subagents directory if it does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    // Verify the directory doesn't exist yet
    assert.equal(existsSync(join(home, '.rivet', 'subagents')), false)
    saveWorkerSession('wo_mkdir', 'code_scout', 'test', makeMessages(), home)
    assert.ok(existsSync(workerSessionPath('wo_mkdir', home)))
  })

  it('workerSessionPath returns the expected location', () => {
    const path = workerSessionPath('wo_abc', '/fake/home')
    assert.equal(path, '/fake/home/.rivet/subagents/wo_abc.session.jsonl')
  })

  it('round-trips complex multimodal and tool messages', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const messages: OaiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
      { role: 'assistant', content: null, reasoning_content: 'thinking deeply', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'file contents here' },
    ]
    saveWorkerSession('wo_complex', 'patcher', 'complex task', messages, home)
    const loaded = loadWorkerSession('wo_complex', home)
    assert.ok(loaded)
    assert.equal(loaded!.messages.length, 3)
    // Verify multimodal user message survives
    const userMsg = loaded!.messages[0]!
    assert.equal(userMsg.role, 'user')
    assert.ok(Array.isArray(userMsg.content))
    // Verify assistant reasoning + tool_calls survive
    const asstMsg = loaded!.messages[1]!
    assert.equal(asstMsg.role, 'assistant')
    assert.equal(asstMsg.reasoning_content, 'thinking deeply')
    assert.ok(asstMsg.tool_calls && asstMsg.tool_calls.length === 1)
  })
})
