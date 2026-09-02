/**
 * P1-1 conversation fork — RuntimeSessionManager.forkSession + POST /sessions/:id/fork.
 *
 * Anti-proof table:
 *   #1 "fork only copies events" → test 2 checks the child model transcript (SessionPersist).
 *   #2 "header fork copies nothing" → test 1 checks copied user events + marker.
 *   #3 "message fork copies the whole conversation" → test 2 checks the prefix ends at the anchor.
 *   #4 "fork title numbering is cosmetic" → test 4 checks Foo → Foo (2) → Foo (3).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { SessionPersist } from '../../agent/session-persist.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// SessionPersist resolves its directory through config/paths.ts; point it at a
// writable temp dir so the test never touches the real ~/.rivet sessions tree.
process.env.RIVET_SESSION_DIR = mkdtempSync(join(tmpdir(), 'rivet-fork-sessions-'))

class ForkableAgent implements ManagedAgent {
  messages: OaiMessage[] = []
  run(_prompt: string): Promise<void> {
    // Resolves immediately — the manager settles the session to idle in a microtask.
    return Promise.resolve()
  }
  finish(): void {}
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
}

function makeMessages(): OaiMessage[] {
  return [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Do task A' },
    { role: 'assistant', content: 'Doing A' },
    { role: 'user', content: 'Now do B' },
    { role: 'assistant', content: 'Doing B' },
  ]
}

const PROMPTS = ['Hello', 'Do task A', 'Now do B']

function setup() {
  const manager = new RuntimeSessionManager({
    createAgent: () => new ForkableAgent(),
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router }
}

const delay = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/** Create a session with N real runs (real user events) + a matching OAI transcript file. */
async function makeSession(
  manager: RuntimeSessionManager,
  opts: { runs?: number; title?: string } = {},
): Promise<{ id: string; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-fork-'))
  const id = manager.createSession({ cwd, title: opts.title ?? 'Foo' }).id
  const runs = opts.runs ?? PROMPTS.length
  for (let i = 0; i < runs; i++) {
    manager.run(id, PROMPTS[i]!)
    await delay()
  }
  // The fake agent doesn't write the model transcript; mirror real sessions by
  // writing the OAI file through the production SessionPersist path.
  const persist = new SessionPersist(id, cwd)
  for (const m of makeMessages().slice(0, runs * 2)) {
    await persist.appendOaiWithChecksum(m)
  }
  await persist.flushSessionBuffer()
  return { id, cwd }
}

test('#1 header fork copies the whole conversation into a new idle session', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 2 })
  try {
    const result = await manager.forkSession(id, { source: 'header' })
    assert.ok(result.ok, `fork should succeed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    const child = result.record

    assert.equal(child.status, 'idle')
    assert.equal(child.forkedFromId, id)
    assert.equal(child.forkTitleNumber, 2)
    assert.equal(child.title, 'Foo (2)')

    const events = manager.getEvents(child.id, 0)!
    const userEvents = events.events.filter((e) => e.type === 'user')
    assert.equal(userEvents.length, 2, 'both user events copied')
    assert.ok(events.events.some((e) => e.type === 'fork'), 'fork marker appended')
    assert.equal(child.forkedFromTurnSeq, userEvents[1]!.seq)

    // Model transcript: child restores the same conversation prefix.
    const childPersist = new SessionPersist(child.id, cwd)
    assert.equal(childPersist.loadOai().length, 4, '2 user + 2 assistant messages')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#2 message fork cuts at the chosen user message (inclusive)', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager)
  try {
    // makeMessages()[4] = "Now do B" — keep through that message, drop the final reply.
    const result = await manager.forkSession(id, { messageIndex: 4, source: 'message' })
    assert.ok(result.ok, `fork should succeed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    const child = result.record

    const events = manager.getEvents(child.id, 0)!
    assert.equal(events.events.filter((e) => e.type === 'user').length, 3)
    const forkMarker = events.events.find((e) => e.type === 'fork')
    assert.ok(forkMarker, 'fork marker appended')
    assert.ok(
      events.events.every((e) => e === forkMarker || e.seq <= child.forkedFromTurnSeq!),
      'only the fork marker may exceed the anchor seq',
    )

    const transcript = new SessionPersist(child.id, cwd).loadOai()
    assert.equal(transcript.length, 5, 'prefix includes the anchor user message')
    assert.equal(transcript[4]!.role, 'user')
    assert.equal((transcript[4] as { content: string }).content, 'Now do B')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#3 fork is rejected while the source session is running', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    manager.run(id, 'another prompt') // don't await — session stays running
    const result = await manager.forkSession(id)
    assert.deepEqual(result, { ok: false, reason: 'running' })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#4 title numbering walks the fork chain (Foo → Foo (2) → Foo (3))', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    const first = await manager.forkSession(id)
    assert.ok(first.ok)
    if (!first.ok) return
    assert.equal(first.record.title, 'Foo (2)')

    const second = await manager.forkSession(first.record.id)
    assert.ok(second.ok)
    if (!second.ok) return
    assert.equal(second.record.title, 'Foo (3)')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#5 invalid messageIndex and missing same-worktree fail closed', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 2 })
  try {
    const badIndex = await manager.forkSession(id, { messageIndex: 1 }) // assistant
    assert.deepEqual(badIndex, { ok: false, reason: 'invalid_message_index' })

    const noWorktree = await manager.forkSession(id, { destination: 'same-worktree' })
    assert.deepEqual(noWorktree, { ok: false, reason: 'same_worktree_unavailable' })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#6 POST /sessions/:id/fork returns the new session', async () => {
  const { manager, router } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    const res = await router('POST', `/sessions/${id}/fork`, { destination: 'local' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { session?: { forkedFromId?: string; title?: string } }
    assert.equal(body.session?.forkedFromId, id)
    assert.equal(body.session?.title, 'Foo (2)')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
