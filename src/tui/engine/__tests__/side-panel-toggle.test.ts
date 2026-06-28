/**
 * T9 side panel toggle tests — /panel slash command and hotkeys.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

const tick = () => new Promise(r => setTimeout(r, 10))

function makeApp(cols = 130) {
  const out = new MockOut(cols, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols,
    rows: 24,
    modelName: 'test',
  })
  return { app, out, stdin }
}

test('side panel is closed by default', () => {
  const { app } = makeApp()
  assert.equal(app.isSidePanelOpen(), false)
})

test('/panel toggles side panel open', async () => {
  const { app, stdin } = makeApp()
  app.setInput('/panel')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.isSidePanelOpen(), true)
})

test('/panel off closes side panel', async () => {
  const { app, stdin } = makeApp()
  app.setInput('/panel')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('/panel off')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.isSidePanelOpen(), false)
})

test('ctrl+] key toggles side panel', async () => {
  const { app, stdin } = makeApp()
  stdin.dataHandler!('\x1d') // ctrl+]
  await tick()
  assert.equal(app.isSidePanelOpen(), true)
  stdin.dataHandler!('\x1d')
  await tick()
  assert.equal(app.isSidePanelOpen(), false)
})

test('ctrl+x r opens side panel', async () => {
  const { app, stdin } = makeApp()
  stdin.dataHandler!('\x18') // ctrl+x
  await tick()
  stdin.dataHandler!('r')
  await tick()
  assert.equal(app.isSidePanelOpen(), true)
})

test('side panel cannot open when terminal is too narrow', async () => {
  const { app, stdin } = makeApp(80)
  stdin.dataHandler!('\x1d') // ctrl+]
  await tick()
  assert.equal(app.isSidePanelOpen(), false)
})

test('side panel toggle is suppressed while overlay is active', async () => {
  const { app, stdin } = makeApp()
  // Open side panel first
  stdin.dataHandler!('\x1d') // ctrl+]
  await tick()
  assert.equal(app.isSidePanelOpen(), true)

  // Force overlay active (bypass renderer check — we only test that toggle is suppressed)
  const overlay = (app as any).overlay
  overlay.active = 'test-overlay'
  assert.equal(overlay.isActive(), true)

  // Try to close side panel via ctrl+] while overlay is active
  stdin.dataHandler!('\x1d')
  await tick()

  // State should NOT have changed — toggle suppressed
  assert.equal(app.isSidePanelOpen(), true, 'side panel should stay open during overlay — toggle suppressed')

  // Deactivate overlay and verify state unchanged
  overlay.active = null
  assert.equal(app.isSidePanelOpen(), true, 'side panel should still be open after overlay closes')
})
