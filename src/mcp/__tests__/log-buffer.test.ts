import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LogRingBuffer } from '../log-buffer.js'

describe('LogRingBuffer', () => {
  it('stores and retrieves entries in order', () => {
    const buf = new LogRingBuffer(1024)
    buf.push({ ts: 1, stream: 'stderr', text: 'line 1' })
    buf.push({ ts: 2, stream: 'stderr', text: 'line 2' })
    const all = buf.all()
    assert.equal(all.length, 2)
    assert.equal(all[0]!.text, 'line 1')
    assert.equal(all[1]!.text, 'line 2')
  })

  it('tail returns last N entries', () => {
    const buf = new LogRingBuffer(1024)
    for (let i = 0; i < 10; i++) buf.push({ ts: i, stream: 'event', text: `msg ${i}` })
    assert.equal(buf.tail(3).length, 3)
    assert.equal(buf.tail(3)[0]!.text, 'msg 7')
  })

  it('evicts oldest entries when capacity exceeded', () => {
    const buf = new LogRingBuffer(50) // ~50 bytes
    for (let i = 0; i < 20; i++) buf.push({ ts: i, stream: 'stderr', text: `line-${i}` })
    // Should have evicted some early entries
    assert.ok(buf.count < 20, `expected < 20 entries, got ${buf.count}`)
    assert.ok(buf.size <= 50, `expected size <= 50, got ${buf.size}`)
  })

  it('respects RIVET_MCP_LOG_BYTES env var', () => {
    process.env.RIVET_MCP_LOG_BYTES = '256'
    const buf = new LogRingBuffer()
    for (let i = 0; i < 50; i++) buf.push({ ts: i, stream: 'stderr', text: 'x'.repeat(20) })
    assert.ok(buf.size <= 256)
    delete process.env.RIVET_MCP_LOG_BYTES
  })
})
