/**
 * P1-2 persistent diff line comments — RuntimeSessionManager + /sessions/:id/comments routes.
 *
 * Anti-proof table:
 *   #1 "comments are memory-only" → test 1 reads them back through the event-log projection.
 *   #2 "resolve/delete mutate history" → test 2 verifies append-only ops keep the add event.
 *   #3 "invalid anchors accepted" → test 3 verifies file/line validation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class CommentAgent implements ManagedAgent {
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
    createAgent: () => new CommentAgent(),
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router }
}

test('#1 add/list comments through the event-log projection', async () => {
  const { manager } = setup()
  const id = manager.createSession({ title: 'Review me' }).id

  const c = manager.addLineComment(id, { file: 'src/a.ts', newLine: 42, comment: 'handle empty input' })
  assert.ok(c, 'add should succeed')
  assert.equal(c.kind, 'user')
  assert.equal(c.file, 'src/a.ts')

  const list = manager.listLineComments(id)
  assert.deepEqual(list, [c], 'projection returns the persisted comment')
})

test('#2 resolve + delete are append-only state transitions', async () => {
  const { manager } = setup()
  const id = manager.createSession().id
  const c = manager.addLineComment(id, { file: 'src/b.ts', oldLine: 7, comment: 'todo' })!

  assert.ok(manager.resolveLineComment(id, c.id))
  assert.equal(manager.listLineComments(id)![0]!.resolved, true)

  assert.ok(manager.deleteLineComment(id, c.id))
  assert.deepEqual(manager.listLineComments(id), [], 'deleted comments leave the live projection')

  // Append-only log: the original add event is still there for replay/audit.
  const events = manager.getEvents(id, 0)!.events
  const adds = events.filter((e) => e.type === 'line_comment' && (e.data as { op?: string }).op === 'add')
  assert.equal(adds.length, 1)
  const deletes = events.filter((e) => e.type === 'line_comment' && (e.data as { op?: string }).op === 'delete')
  assert.equal(deletes.length, 1)
})

test('#3 invalid anchors and unknown comment ids fail closed', async () => {
  const { manager } = setup()
  const id = manager.createSession().id

  assert.equal(manager.addLineComment(id, { file: '', newLine: 1, comment: 'x' }), undefined)
  assert.equal(manager.addLineComment(id, { file: 'src/c.ts', comment: 'x' }), undefined)
  assert.equal(manager.resolveLineComment(id, 'nope'), false)
  assert.equal(manager.deleteLineComment(id, 'nope'), false)
})

test('#4 HTTP routes round-trip (add → list → resolve → delete)', async () => {
  const { manager, router } = setup()
  const id = manager.createSession().id

  const added = await router('POST', `/sessions/${id}/comments`, {
    file: 'src/d.ts', newLine: 3, comment: 'derive this type',
  }, AUTH)
  assert.equal(added.status, 200)
  const comment = (added.body as { comment?: { id?: string } }).comment
  assert.ok(comment?.id)

  const listed = await router('GET', `/sessions/${id}/comments`, {}, AUTH)
  assert.equal(listed.status, 200)
  assert.equal((listed.body as { comments?: unknown[] }).comments?.length, 1)

  const resolved = await router('POST', `/sessions/${id}/comments/${comment.id}/resolve`, {}, AUTH)
  assert.equal(resolved.status, 200)
  assert.equal((resolved.body as { ok?: boolean }).ok, true)

  const deleted = await router('DELETE', `/sessions/${id}/comments/${comment.id}`, {}, AUTH)
  assert.equal(deleted.status, 200)
  assert.equal((deleted.body as { ok?: boolean }).ok, true)
})

test('#5 missing comment body returns 400; missing session returns 404', async () => {
  const { manager, router } = setup()
  const id = manager.createSession().id

  const bad = await router('POST', `/sessions/${id}/comments`, { file: 'src/e.ts' }, AUTH)
  assert.equal(bad.status, 400)

  const missing = await router('GET', '/sessions/nope/comments', {}, AUTH)
  assert.equal(missing.status, 404)
})
