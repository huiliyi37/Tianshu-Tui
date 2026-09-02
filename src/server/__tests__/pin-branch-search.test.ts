/**
 * P1-3 — session pin + branch-name cross-session search.
 *
 * Anti-proof table:
 *   #1 "pin is UI-only" → test 1 verifies record + append-only event.
 *   #2 "branch search reads transcripts" → test 3 matches branch with a
 *      throwing transcript reader (branch index must stand alone).
 *   #3 "pin endpoint is unvalidated" → test 4 checks 400/404.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { searchSessionTranscripts } from '../session-search.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class PinAgent implements ManagedAgent {
  run(_prompt: string): Promise<void> { return Promise.resolve() }
  finish(): void {}
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
}

function setup() {
  const manager = new RuntimeSessionManager({
    createAgent: () => new PinAgent(),
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router }
}

test('#1 pin persists on the record and emits an append-only event', () => {
  const { manager } = setup()
  const id = manager.createSession({ title: 'Pin me' }).id

  const pinned = manager.setSessionPinned(id, true)!
  assert.equal(pinned.pinned, true)

  const events = manager.getEvents(id, 0)!.events
  const pinEvents = events.filter((e) => e.type === 'session_pinned')
  assert.equal(pinEvents.length, 1)
  assert.equal((pinEvents[0]!.data as { pinned?: boolean }).pinned, true)

  // Idempotent: no duplicate event when the state doesn't change.
  manager.setSessionPinned(id, true)
  assert.equal(manager.getEvents(id, 0)!.events.filter((e) => e.type === 'session_pinned').length, 1)

  manager.setSessionPinned(id, false)
  assert.equal(manager.getSession(id)!.pinned, false)
})

test('#2 POST /sessions/:id/pin round-trips', async () => {
  const { manager, router } = setup()
  const id = manager.createSession().id

  const res = await router('POST', `/sessions/${id}/pin`, { pinned: true }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { pinned?: boolean }).pinned, true)
})

test('#3 branch search stands alone (no transcript read required)', async () => {
  const result = await searchSessionTranscripts(
    [{ id: 'sess-branch', title: 'Landing rewrite', cwd: '/tmp', branch: 'feature/landing' }],
    'landing',
    {
      // Transcript reader always throws — the branch hit must still surface.
      readFile: async () => { throw new Error('no transcript') },
    },
  )
  assert.equal(result.results.length, 1)
  const hit = result.results[0]!
  assert.equal(hit.role, 'branch')
  assert.equal(hit.matchedField, 'branch')
  assert.equal(hit.branch, 'feature/landing')
})

test('#4 pin route validates body and missing sessions', async () => {
  const { manager, router } = setup()
  const id = manager.createSession().id

  const bad = await router('POST', `/sessions/${id}/pin`, { pinned: 'yes' }, AUTH)
  assert.equal(bad.status, 400)

  const missing = await router('POST', '/sessions/nope/pin', { pinned: true }, AUTH)
  assert.equal(missing.status, 404)
})
