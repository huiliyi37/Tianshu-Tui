/**
 * Wave G — sidecar per-cwd 共享资源（Meridian / LSP）。
 *
 * 覆盖：同 cwd 共享单实例、不同 cwd 隔离、close() 后 map 清空 + dispose 调用、
 * LSP mock 注册（ready 后工具进 registry + updateTools 被调；ready=false 不注册；
 * 晚订阅（switchModel 重建 agent）照样收到 updateTools）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOrCreateMeridianIndexer,
  disposeSharedCwdResources,
  attachLspTools,
  type SharedRuntime,
} from '../serve-agent.js'
import { ProviderHealthTracker } from '../../agent/provider-health.js'
import type { LspManager } from '../../lsp/manager.js'
import type { Tool } from '../../tools/types.js'

function makeShared(): SharedRuntime {
  return {
    providerHealth: new ProviderHealthTracker(),
    domainStores: new Map(),
    meridianIndexers: new Map(),
    lspManagers: new Map(),
    sameCwdRunningCount: null,
    mcpManager: null,
    sessions: null,
  }
}

function makeMockLspManager(overrides: Partial<LspManager> = {}): LspManager & { disposed: boolean } {
  const mock = {
    disposed: false,
    initialize: async () => {},
    isReady: () => true,
    supportsDefinition: () => true,
    supportsReferences: () => true,
    gotoDefinition: async () => [],
    findReferences: async () => [],
    changeFile: () => {},
    getFileDiagnostics: async () => [],
    dispose() { mock.disposed = true },
    ...overrides,
  }
  return mock as LspManager & { disposed: boolean }
}

test('same cwd returns the same MeridianIndexer instance; different cwd is isolated', () => {
  const shared = makeShared()
  const cwdA = mkdtempSync(join(tmpdir(), 'waveg-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'waveg-b-'))
  try {
    const first = getOrCreateMeridianIndexer(shared, cwdA)
    const second = getOrCreateMeridianIndexer(shared, cwdA)
    const other = getOrCreateMeridianIndexer(shared, cwdB)
    assert.equal(first, second, 'same cwd must share one instance')
    assert.notEqual(first, other, 'different cwd must get its own instance')
    assert.equal(shared.meridianIndexers.size, 2)
  } finally {
    disposeSharedCwdResources(shared)
    rmSync(cwdA, { recursive: true, force: true })
    rmSync(cwdB, { recursive: true, force: true })
  }
})

test('disposeSharedCwdResources closes indexers, disposes LSP managers, clears maps', () => {
  const shared = makeShared()
  const cwd = mkdtempSync(join(tmpdir(), 'waveg-close-'))
  try {
    getOrCreateMeridianIndexer(shared, cwd)
    const manager = makeMockLspManager()
    shared.lspManagers.set(cwd, { manager, ready: Promise.resolve(true) })

    disposeSharedCwdResources(shared)
    assert.equal(shared.meridianIndexers.size, 0)
    assert.equal(shared.lspManagers.size, 0)
    assert.equal(manager.disposed, true)

    // Idempotent: a second dispose over empty maps must not throw.
    disposeSharedCwdResources(shared)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('dispose survives a throwing manager (try-catch per resource)', () => {
  const shared = makeShared()
  const bad = makeMockLspManager({ dispose: () => { throw new Error('boom') } })
  const good = makeMockLspManager()
  shared.lspManagers.set('/bad', { manager: bad, ready: Promise.resolve(true) })
  shared.lspManagers.set('/good', { manager: good, ready: Promise.resolve(true) })

  disposeSharedCwdResources(shared)
  assert.equal(shared.lspManagers.size, 0)
  assert.equal(good.disposed, true, 'later resources still disposed after one throws')
})

test('attachLspTools registers goto/find tools and refreshes the agent when ready', async () => {
  const manager = makeMockLspManager()
  const registered: string[] = []
  const registry = { register: (t: Tool) => { registered.push(t.definition.name) } }
  const refs: { lspManager: LspManager | null } = { lspManager: null }
  let updates = 0

  await attachLspTools(
    { manager, ready: Promise.resolve(true) },
    registry,
    refs,
    () => { updates++ },
  )

  assert.deepEqual(registered.sort(), ['lsp_find_references', 'lsp_goto_definition'])
  assert.equal(refs.lspManager, manager)
  assert.equal(updates, 1)
})

test('attachLspTools does nothing when no language server is available (ready=false)', async () => {
  const manager = makeMockLspManager()
  const registered: string[] = []
  const refs: { lspManager: LspManager | null } = { lspManager: null }
  let updates = 0

  await attachLspTools(
    { manager, ready: Promise.resolve(false) },
    { register: (t: Tool) => { registered.push(t.definition.name) } },
    refs,
    () => { updates++ },
  )

  assert.deepEqual(registered, [])
  assert.equal(refs.lspManager, null)
  assert.equal(updates, 0)
})

test('late subscription (switchModel rebuild) still receives updateTools on a resolved entry', async () => {
  const manager = makeMockLspManager()
  const entry = { manager, ready: Promise.resolve(true) }
  const registry = { register: (_t: Tool) => {} }

  // First agent subscribes and completes.
  const refsA: { lspManager: LspManager | null } = { lspManager: null }
  let updatesA = 0
  await attachLspTools(entry, registry, refsA, () => { updatesA++ })
  assert.equal(updatesA, 1)

  // switchModel builds a new agent afterwards — the promise is long resolved,
  // yet the per-assemble subscription still fires for the new agent.
  const refsB: { lspManager: LspManager | null } = { lspManager: null }
  let updatesB = 0
  await attachLspTools(entry, registry, refsB, () => { updatesB++ })
  assert.equal(updatesB, 1)
  assert.equal(refsB.lspManager, manager)
})
