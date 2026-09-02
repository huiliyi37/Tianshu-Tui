import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rememberUserNote, listUserNotes } from '../user-remember.js'
import { readMemoryEntries } from '../unified-memory.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rivet-user-remember-'))
  return () => rmSync(cwd, { recursive: true, force: true })
})

describe('user /remember', () => {
  it('writes a verified manual entry that survives into recall', () => {
    const result = rememberUserNote(cwd, '构建前必须跑 npm run budgets:check，否则 architecture-guards 会红', 'session-1')
    assert.equal(result.ok, true)
    const entries = readMemoryEntries(cwd)
    const entry = entries.find(e => e.id === result.entryId)
    assert.ok(entry)
    assert.equal(entry.source, 'manual')
    assert.equal(entry.status, 'verified')
    assert.equal(entry.topic, 'user')
    assert.deepEqual(entry.tags, ['user', 'remember'])
    // listUserNotes 只看 manual 且当前有效
    assert.equal(listUserNotes(cwd)[0]?.id, result.entryId)
  })

  it('rejects sensitive content (scrub) and near-empty text', () => {
    const secret = rememberUserNote(cwd, 'my key is sk-abcdefghijklmnopqrstuvwxyz123456')
    assert.equal(secret.ok, false)
    assert.match(secret.message, /API key|token|密码/)
    assert.equal(readMemoryEntries(cwd).length, 0)

    const short = rememberUserNote(cwd, 'ab')
    assert.equal(short.ok, false)
  })

  it('is idempotent for identical content', () => {
    const first = rememberUserNote(cwd, '部署脚本在 scripts/pack-native.js，别手抄命令')
    assert.equal(first.ok, true)
    const second = rememberUserNote(cwd, '部署脚本在 scripts/pack-native.js，别手抄命令')
    assert.equal(second.ok, false)
    assert.match(second.message, /相同/)
    assert.equal(readMemoryEntries(cwd).length, 1)
  })
})
