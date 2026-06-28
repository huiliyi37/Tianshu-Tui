import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { InputHandler, type KeyPress } from '../input-handler.js'
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

  it('buffers split paste start marker across chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let keys = 0
    handler.onPaste((t) => { pasted = t })
    handler.onAnyKey(() => { keys++ })

    stdin.emitData('\x1B[200')
    assert.equal(pasted, null, 'start marker incomplete — no paste')
    assert.equal(keys, 0, 'no spurious keys from partial marker')

    stdin.emitData('~split-start\x1B[201~')
    assert.equal(pasted, 'split-start', 'paste assembled across start-marker boundary')
    assert.equal(keys, 0, 'still no regular keys')
    handler.dispose()
  })

  it('buffers split paste end marker across chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    let pasted: string | null = null
    let returns = 0
    handler.onPaste((t) => { pasted = t })
    handler.onKey('return', () => { returns++ })

    stdin.emitData('\x1B[200~split-end\x1B[201')
    assert.equal(pasted, null, 'end marker incomplete — paste held')

    stdin.emitData('~\r')
    assert.equal(pasted, 'split-end', 'paste closed across end-marker boundary')
    assert.equal(returns, 1, 'trailing CR after paste submits')
    handler.dispose()
  })
})

describe('InputHandler · multi-sequence chunks (领航星 2026-06-11 UX)', () => {
  it('parses two arrow keys in one chunk', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: string[] = []
    handler.onAnyKey((k) => { keys.push(k.name) })

    stdin.emitData('\x1B[A\x1B[B')
    assert.deepEqual(keys, ['up', 'down'], 'each arrow key dispatched separately')
    handler.dispose()
  })

  it('parses escape sequence followed by printable char in one chunk', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: string[] = []
    handler.onAnyKey((k) => { keys.push(k.name) })

    stdin.emitData('\x1B[Aa')
    assert.deepEqual(keys, ['up', 'unknown'], 'arrow key then normal char')
    handler.dispose()
  })
})

describe('InputHandler · surrogate-pair chunk buffering (领航星 2026-06-11 UX)', () => {
  it('assembles a split emoji surrogate pair across two data chunks', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const chars: string[] = []
    handler.onAnyKey((k) => { if (k.char) chars.push(k.char) })

    // 终端流量控制 / 高频输入下，😀 (\uD83D\uDE00) 可能被拆成两段。
    // 旧实现会把第一段当孤立高代理派发，输入框渲染豆腐方块。
    // 新行为：第一段先 buffer，不派发；合并第二段后整体派发。
    stdin.emitData('\uD83D')  // 高代理
    assert.deepEqual(chars, [], 'lone high surrogate must not dispatch')

    stdin.emitData('\uDE00')  // 低代理
    assert.deepEqual(chars, ['\uD83D\uDE00'], 'assembled emoji dispatched as one char')
    handler.dispose()
  })

  it('a normal key after a buffered surrogate still dispatches', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const chars: string[] = []
    handler.onAnyKey((k) => { if (k.char) chars.push(k.char) })

    stdin.emitData('\uD83D')        // buffer
    stdin.emitData('\uDE00a')       // 完成 emoji + 接一个 'a'
    assert.deepEqual(chars, ['\uD83D\uDE00', 'a'])
    handler.dispose()
  })

  it('dispose clears pending surrogate buffer (no late dispatch)', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const chars: string[] = []
    handler.onAnyKey((k) => { if (k.char) chars.push(k.char) })

    stdin.emitData('\uD83D')  // buffered
    handler.dispose()
    // 模拟上游在 dispose 后又来了一段——应当无副作用
    stdin.emitData('\uDE00')
    assert.deepEqual(chars, [])
  })
})

describe('InputHandler · Shift+Tab and Alt+letter (领航星 2026-06-28)', () => {
  it('parses Shift+Tab (\\x1B[Z) as shift_tab', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B[Z')
    assert.equal(keys.length, 1, 'one key dispatched')
    assert.equal(keys[0]!.name, 'shift_tab')
    assert.equal(keys[0]!.shift, true)
    handler.dispose()
  })

  it('parses Alt+f (\\x1Bf) as meta=true', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1Bf')
    assert.equal(keys.length, 1, 'one key dispatched')
    assert.equal(keys[0]!.char, 'f')
    assert.equal(keys[0]!.meta, true, 'Alt key should set meta=true')
    assert.equal(keys[0]!.ctrl, false)
    handler.dispose()
  })

  it('parses Alt+Shift+F (\\x1BF) as meta=true shift=true', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1BF')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.char, 'F')
    assert.equal(keys[0]!.meta, true)
    assert.equal(keys[0]!.shift, true, 'uppercase implies shift')
    handler.dispose()
  })

  it('Alt+digit parses correctly (\\x1B1 → char=1 meta=true)', () => {
    const stdin = makeStdin()
    const handler = new InputHandler({ stdin })
    const keys: KeyPress[] = []
    handler.onAnyKey((k) => { keys.push(k) })

    stdin.emitData('\x1B1')
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.char, '1')
    assert.equal(keys[0]!.meta, true)
    handler.dispose()
  })
})
