import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShutdownHandler, type BootstrapContext } from '../../bootstrap.js'

interface ShutdownFixture {
  ctx: BootstrapContext
  unregistered: string[]
}

function makeFixture(workerSettled: boolean, mainRunning = false): ShutdownFixture {
  const unregistered: string[] = []
  const heartbeatInterval = setInterval(() => {}, 60_000)
  const ctx = {
    sessionId: 'tui-main',
    cwd: process.cwd(),
    heartbeatInterval,
    persist: {
      updateMetadata: () => {},
      writeFrozenSnapshot: () => {},
      compactOai: () => {},
    },
    session: { getMessages: () => [] },
    fileHistory: null,
    agent: {
      config: { promptEngine: { exportFrozenSnapshot: () => ({}) } },
      flushStigmergySync: () => {},
      abort: () => {},
      isRunning: () => mainRunning,
    },
    refs: {
      coordinator: { shutdownAndWait: async () => workerSettled },
      sessionRegistry: { unregister: (id: string) => { unregistered.push(id) } },
      lspManager: null,
      mcpManager: null,
    },
  } as unknown as BootstrapContext
  return { ctx, unregistered }
}

test('shutdown unregisters a TUI session after all work has settled', async () => {
  const fixture = makeFixture(true)
  await createShutdownHandler(fixture.ctx)()
  assert.deepEqual(fixture.unregistered, ['tui-main'])
})

test('shutdown keeps the registry row when a worker shutdown times out', async () => {
  const fixture = makeFixture(false)
  await createShutdownHandler(fixture.ctx)()
  assert.deepEqual(fixture.unregistered, [])
})

test('shutdown keeps the registry row while the main turn is still running', async () => {
  const fixture = makeFixture(true, true)
  await createShutdownHandler(fixture.ctx)()
  assert.deepEqual(fixture.unregistered, [])
})
