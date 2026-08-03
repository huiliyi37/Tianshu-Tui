import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'

describe('FileSessionPersistence events disk trim', () => {
  it('trims events.jsonl to keep only the trailing maxEventsDiskBytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-trim-'))
    try {
      const store = new FileSessionPersistence(dir, { maxEventsDiskBytes: 200 })
      const sid = 's1'
      mkdirSync(join(dir, sid), { recursive: true })
      const file = join(dir, sid, 'events.jsonl')
      const lines = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ seq: i + 1, ts: i, type: 'status', data: { pad: 'x'.repeat(20) } }) + '\n',
      )
      writeFileSync(file, lines.join(''))
      const before = statSync(file).size
      assert.ok(before > 200)

      store.trimEventsFileIfNeeded(sid)
      const after = statSync(file).size
      assert.ok(after <= 200, `expected <=200 got ${after}`)
      assert.ok(after > 0)
      const text = readFileSync(file, 'utf8').trim()
      for (const line of text.split('\n')) {
        const obj = JSON.parse(line) as { seq: number }
        assert.ok(typeof obj.seq === 'number')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
