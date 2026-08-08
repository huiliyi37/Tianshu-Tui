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
      // events_trimmed marker 行让文件略超上限（去重后稳态不再增长）
      assert.ok(after <= 200 + 512, `expected <=${200 + 512} got ${after}`)
      assert.ok(after > 0)
      const text = readFileSync(file, 'utf8').trim()
      const afterLines = text.split('\n')
      for (const line of afterLines) {
        const obj = JSON.parse(line) as { seq?: number; type?: string }
        if (obj.type !== 'events_trimmed') {
          assert.ok(typeof obj.seq === 'number')
        }
      }
      // 裁剪 marker 落在文件末尾，字段完整可 parse
      const marker = JSON.parse(afterLines[afterLines.length - 1]!) as {
        type: string
        data: { removedBytes: number; keptBytes: number }
      }
      assert.equal(marker.type, 'events_trimmed')
      assert.ok(typeof marker.data.removedBytes === 'number')
      assert.ok(typeof marker.data.keptBytes === 'number')

      // 去重：文件仍超限时再次 trim，保留区尾部已是 marker → 不再追加
      store.trimEventsFileIfNeeded(sid)
      const markerCount = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(l => (JSON.parse(l) as { type?: string }).type === 'events_trimmed').length
      assert.equal(markerCount, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
