import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { InputHandler } from '../input-handler.js'
import type { ReadStream } from 'node:tty'

/** 最小 stdin mock：满足 InputHandler 构造期调用，并能注入 data。 */
function makeStdin(): ReadStream & { emitData(s: string): void } {
  const ee = new EventEmitter() as unknown as ReadStream & { emitData(s: string): void }
  ;(ee as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(ee as unknown as { resume: () => void }).resume = () => {}
  ;(ee as unknown as { pause: () => void }).pause = () => {}
  ;(ee as unknown as { setEncoding: () => void }).setEncoding = () => {}
  ;(ee as { emitData(s: string): void }).emitData = (s: string) => ee.emit('data', s)
  return ee
}

describe('InputHandler · escape timeout dispatch (B1)', () => {
  it('lone ESC dispatches escape after timeout', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20 })
    let escapes = 0
    handler.onKey('escape', () => { escapes++ })

    stdin.emitData('\x1B')
    assert.equal(escapes, 0, 'no immediate dispatch — still buffered')
    await delay(40)
    assert.equal(escapes, 1, 'escape dispatched after timeout')
    handler.dispose()
  })

  it('ESC followed quickly by [A parses as up (not escape)', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 50 })
    let escapes = 0
    let ups = 0
    handler.onKey('escape', () => { escapes++ })
    handler.onKey('up', () => { ups++ })

    stdin.emitData('\x1B')
    stdin.emitData('[A')
    await delay(80)
    assert.equal(ups, 1, 'arrow up dispatched')
    assert.equal(escapes, 0, 'no spurious escape')
    handler.dispose()
  })

  it('dispose clears a pending escape timer (no late dispatch)', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin, escapeTimeoutMs: 20 })
    let escapes = 0
    handler.onKey('escape', () => { escapes++ })
    stdin.emitData('\x1B')
    handler.dispose()
    await delay(40)
    assert.equal(escapes, 0, 'disposed before timer fired')
  })
})

describe('InputHandler · bracketed paste (C1)', () => {
  it('emits paste content without triggering return/submit', async () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let returns = 0
    handler.onPaste((t) => { pasted = t })
    handler.onKey('return', () => { returns++ })

    stdin.emitData('\x1B[200~line1\nline2\x1B[201~')
    assert.equal(pasted, 'line1\nline2')
    assert.equal(returns, 0, 'no submit during paste')
    handler.dispose()
  })

  it('normalizes CR / CRLF to LF', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    handler.onPaste((t) => { pasted = t })

    stdin.emitData('\x1B[200~a\r\nb\rc\x1B[201~')
    assert.equal(pasted, 'a\nb\nc')
    handler.dispose()
  })

  it('buffers paste across chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    handler.onPaste((t) => { pasted = t })

    stdin.emitData('\x1B[200~hello ')
    assert.equal(pasted, null, 'not emitted until end marker')
    stdin.emitData('world\x1B[201~')
    assert.equal(pasted, 'hello world')
    handler.dispose()
  })

  it('processes a normal key after the paste end marker', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let returns = 0
    handler.onPaste((t) => { pasted = t })
    handler.onKey('return', () => { returns++ })

    stdin.emitData('\x1B[200~text\x1B[201~\r')
    assert.equal(pasted, 'text')
    assert.equal(returns, 1, 'trailing CR after paste submits')
    handler.dispose()
  })
})
