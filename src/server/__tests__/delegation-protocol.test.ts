import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import {
  DELEGATE_TIMEOUT_MS,
  TIANSHU_PROTOCOL_HEADER,
  TIANSHU_PROTOCOL_VERSION,
  parseDelegateKinds,
} from '../delegation-protocol.js'
import { buildSessionRoutes } from '../session-routes.js'

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  messages: OaiMessage[] = []
  private resolveRun?: () => void
  run(_prompt: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  abort(): void { this.resolveRun?.() }
  listArtifacts() { return [] }
  async readArtifact() { return null }
  getMessages() { return this.messages }
  replaceMessages(msgs: OaiMessage[]) { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]) { this.messages = msgs }
}

describe('delegation-protocol helpers', () => {
  it('parseDelegateKinds filters unknowns and dedupes', () => {
    assert.deepEqual(parseDelegateKinds(['apply_edit', 'nope', 'apply_edit', 'terminal_exec']), [
      'apply_edit',
      'terminal_exec',
    ])
  })
})

describe('E4 PendingDelegation lifecycle', () => {
  let cwd: string
  let manager: RuntimeSessionManager
  let agents: FakeAgent[]

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'delegate-'))
    writeFileSync(join(cwd, 'a.txt'), 'old\n')
    agents = []
    manager = new RuntimeSessionManager({
      createAgent: () => {
        const a = new FakeAgent()
        agents.push(a)
        return a
      },
      defaultCwd: cwd,
      approvalTimeoutMs: 0,
      watchdogContinueDelayMs: 0,
    })
  })

  after(() => {
    manager.shutdownAll()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('capability register / clear / has', () => {
    const rec = manager.createSession({ cwd, title: 'd1' })
    assert.equal(manager.hasDelegateCapability(rec.id, 'apply_edit'), false)
    assert.ok(manager.registerDelegateCapabilities(rec.id, 'client-a', ['apply_edit']))
    assert.equal(manager.hasDelegateCapability(rec.id, 'apply_edit'), true)
    assert.ok(manager.clearDelegateCapabilities(rec.id, 'client-a'))
    assert.equal(manager.hasDelegateCapability(rec.id, 'apply_edit'), false)
  })

  it('register → hang → answerDelegation resolves result', async () => {
    const rec = manager.createSession({ cwd, title: 'd2', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    assert.ok(cb.onToolDelegate)
    manager.registerDelegateCapabilities(rec.id, 'c1', ['apply_edit'])

    const hangPromise = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
    })
    await new Promise((r) => setImmediate(r))
    const events = manager.getEvents(rec.id, 0)
    const delEv = events?.events.find((e) => e.type === 'tool_delegate')
    assert.ok(delEv, 'tool_delegate event emitted')
    const rid = String(delEv!.data.requestId)
    assert.ok(manager.answerDelegation(rec.id, rid, { content: 'ok', status: 'ok' }))
    const result = await hangPromise
    assert.equal(result?.content, 'ok')
    assert.equal(result?.status, 'ok')
  })

  it('SSE/capability clear mid-flight → resolve(null) fail-back', async () => {
    const rec = manager.createSession({ cwd, title: 'd3', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c2', ['apply_edit'])
    const hangPromise = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: '', newContent: 'x',
    })
    await new Promise((r) => setImmediate(r))
    manager.clearDelegateCapabilities(rec.id, 'c2')
    const result = await hangPromise
    assert.equal(result, null)
  })

  it('reject result keeps isError false', async () => {
    const rec = manager.createSession({ cwd, title: 'd4', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c3', ['apply_edit'])
    const hangPromise = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'a', newContent: 'b',
    })
    await new Promise((r) => setImmediate(r))
    const events = manager.getEvents(rec.id, 0)
    const rid = String(events!.events.find((e) => e.type === 'tool_delegate')!.data.requestId)
    assert.ok(
      manager.answerDelegation(rec.id, rid, {
        content: 'User rejected edit to a.txt',
        isError: false,
        status: 'rejected',
      }),
    )
    const result = await hangPromise
    assert.equal(result?.isError, false)
    assert.equal(result?.status, 'rejected')
  })

  it('SSE subscribe teardown with clientId clears capabilities', () => {
    const rec = manager.createSession({ cwd, title: 'd5' })
    manager.registerDelegateCapabilities(rec.id, 'sse-client', ['terminal_exec'])
    assert.equal(manager.hasDelegateCapability(rec.id, 'terminal_exec'), true)
    const unsub = manager.subscribe(rec.id, () => {}, { clientId: 'sse-client' })
    assert.ok(unsub)
    unsub!()
    assert.equal(manager.hasDelegateCapability(rec.id, 'terminal_exec'), false)
  })

  it('no capability → immediate null (zero behavior change)', async () => {
    const rec = manager.createSession({ cwd, title: 'd6', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    const result = await cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: '', newContent: 'x',
    })
    assert.equal(result, null)
    void rec
  })
})

describe('E4 routes + protocol header', () => {
  it('delegate endpoints exist; withAuth stamps protocol header', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'delegate-routes-'))
    try {
      const manager = new RuntimeSessionManager({
        createAgent: () => new FakeAgent(),
        defaultCwd: cwd,
      })
      const routes = buildSessionRoutes(manager, 'tok')
      assert.ok(routes['POST /sessions/:id/delegate-capabilities'])
      assert.ok(routes['POST /sessions/:id/delegate/:requestId/result'])
      const rec = manager.createSession({ cwd, title: 'r1' })
      const cap = await routes['POST /sessions/:id/delegate-capabilities']!(
        { clientId: 'x', kinds: ['apply_edit'] },
        { id: rec.id },
        { authorization: 'Bearer tok' },
      )
      assert.equal(cap.status, 200)
      assert.equal(cap.headers?.[TIANSHU_PROTOCOL_HEADER], String(TIANSHU_PROTOCOL_VERSION))
      assert.ok(DELEGATE_TIMEOUT_MS.apply_edit >= 60_000, 'apply_edit 人审窗口至少 1 分钟，禁止退回 15s 自动接受')
      manager.shutdownAll()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
