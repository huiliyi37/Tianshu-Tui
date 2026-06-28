/**
 * Unified slash command registry tests (P2).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { SlashCommandRegistry } from '../../slash-command-registry.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

test('registry registers, lists, and matches commands', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/help', description: 'Show help', handler: () => true })
  reg.registerMany([
    { name: '/clear', handler: () => true },
    { name: '/team', handler: () => false },
  ])

  assert.equal(reg.has('/help'), true)
  assert.equal(reg.has('/unknown'), false)
  assert.deepEqual(reg.list().map(c => c.name), ['/clear', '/help', '/team'])

  assert.equal(reg.match('/help')?.name, '/help')
  assert.equal(reg.match('/team max plan')?.name, '/team')
  assert.equal(reg.match('/unknown'), undefined)
})

test('registry execute runs handler and returns handled', async () => {
  const reg = new SlashCommandRegistry()
  let called = false
  reg.register({
    name: '/test',
    handler: (ctx) => {
      called = true
      assert.equal(ctx.trimmed, '/test args')
      return true
    },
  })

  const { app } = makeApp()
  const result = await reg.execute({ app, input: '/test args', trimmed: '/test args' })
  assert.equal(result.handled, true)
  assert.equal(called, true)
})

test('registry execute opens overlay when command declares overlay', async () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ starmapEntries: () => ({ entries: [] }) })

  app.registerSlashCommand({
    name: '/map',
    overlay: 'starmap',
    handler: () => true,
  })

  app.setInput('/map')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(app.activeOverlayId(), 'starmap')
})

test('registry unknown command falls through to agent', async () => {
  const { app, stdin } = makeApp()
  const slashInputs: string[] = []
  const normalInputs: string[] = []
  app.setSlashHandler((input) => { slashInputs.push(input); return false })
  app.onSubmit((text) => { normalInputs.push(text) })

  app.setInput('/not-a-registered-cmd')
  stdin.dataHandler!('\r')
  await tick()

  assert.deepEqual(slashInputs, ['/not-a-registered-cmd'])
  assert.deepEqual(normalInputs, ['/not-a-registered-cmd'])
})

test('built-in /starmap still activates overlay through registry', async () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ starmapEntries: () => ({ entries: [] }) })

  app.setInput('/starmap')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(app.activeOverlayId(), 'starmap')
})
