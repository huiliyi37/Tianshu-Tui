import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type PersistedSession,
  type SessionEvent,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// A 1x1 transparent PNG (valid base64) — small, decodes to real bytes.
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX_B64}`

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  runImages: (string[] | undefined)[] = []
  private resolveRun?: () => void
  run(_p: string, cb: AgentCallbacks, images?: string[]) {
    this.callbacks = cb
    this.runImages.push(images)
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** In-memory persistence WITH image support, mirroring the on-disk semantics. */
class MemoryImagePersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  images = new Map<string, { bytes: Buffer; mime: string }>()
  saveRecord(record: SessionRecord): void { this.records.set(record.id, record) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] { return [] }
  saveImage(sessionId: string, imgId: string, base64: string, mime: string): void {
    this.images.set(`${sessionId}/${imgId}`, { bytes: Buffer.from(base64, 'base64'), mime })
  }
  readImage(sessionId: string, imgId: string) {
    return this.images.get(`${sessionId}/${imgId}`)
  }
}

function setup(persistence?: SessionPersistenceAdapter) {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    persistence,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

// ---- FileSessionPersistence saveImage/readImage roundtrip ----

test('FileSessionPersistence saveImage/readImage roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-img-'))
  const p = new FileSessionPersistence(dir)
  p.saveImage('sess1', 'imgA', PNG_1PX_B64, 'image/png')
  const got = p.readImage('sess1', 'imgA')
  assert.ok(got, 'image should be readable back')
  assert.equal(got!.mime, 'image/png')
  assert.deepEqual(got!.bytes, Buffer.from(PNG_1PX_B64, 'base64'))
})

test('FileSessionPersistence maps jpeg mime to .jpg and reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-img-'))
  const p = new FileSessionPersistence(dir)
  // Reuse the PNG bytes as an opaque payload; only mime/ext mapping matters here.
  p.saveImage('s', 'j1', PNG_1PX_B64, 'image/jpeg')
  const got = p.readImage('s', 'j1')
  assert.ok(got)
  assert.equal(got!.mime, 'image/jpeg')
})

test('FileSessionPersistence readImage returns undefined when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-img-'))
  const p = new FileSessionPersistence(dir)
  assert.equal(p.readImage('nope', 'nope'), undefined)
})

// ---- session-manager: persist as ids, model still gets data URLs ----

test('run persists images as ids and keeps base64 out of the event log', () => {
  const persistence = new MemoryImagePersistence()
  const { manager, agents } = setup(persistence)
  const rec = manager.createSession({ cwd: '/tmp/work' })
  manager.run(rec.id, 'look', [PNG_DATA_URL])

  // Model path: the agent received the inline data URL (unchanged).
  assert.deepEqual(agents[0]!.runImages[0], [PNG_DATA_URL])

  // Event log: the user event carries imageIds + imageCount, NOT base64 images.
  const result = manager.getEvents(rec.id, 0)!
  const userEv = result.events.find((e) => e.type === 'user')!
  assert.equal(userEv.data.imageCount, 1)
  assert.ok(Array.isArray(userEv.data.imageIds) && (userEv.data.imageIds as string[]).length === 1)
  assert.equal(userEv.data.images, undefined, 'base64 must not leak into the event log')

  // The persisted image is readable by its id.
  const imgId = (userEv.data.imageIds as string[])[0]!
  const got = manager.readImage(rec.id, imgId)
  assert.ok(got)
  assert.deepEqual(got!.bytes, Buffer.from(PNG_1PX_B64, 'base64'))
})

// ---- POST /prompt validation (format allowlist + size + count) ----

async function createIdle(router: ReturnType<typeof setup>['router']): Promise<string> {
  const created = await router('POST', '/sessions', {}, AUTH)
  return (created.body as { id: string }).id
}

test('POST /prompt rejects bmp and svg, accepts png', async () => {
  const { router } = setup(new MemoryImagePersistence())
  const id = await createIdle(router)

  const bmp = await router('POST', `/sessions/${id}/prompt`,
    { prompt: 'x', images: ['data:image/bmp;base64,QQ=='] }, AUTH)
  assert.equal(bmp.status, 400)

  const svg = await router('POST', `/sessions/${id}/prompt`,
    { prompt: 'x', images: ['data:image/svg+xml;base64,QQ=='] }, AUTH)
  assert.equal(svg.status, 400)

  const png = await router('POST', `/sessions/${id}/prompt`,
    { prompt: 'x', images: [PNG_DATA_URL] }, AUTH)
  assert.equal(png.status, 200)
})

test('POST /prompt rejects more than 4 images', async () => {
  const { router } = setup(new MemoryImagePersistence())
  const id = await createIdle(router)
  const five = Array.from({ length: 5 }, () => PNG_DATA_URL)
  const res = await router('POST', `/sessions/${id}/prompt`, { prompt: 'x', images: five }, AUTH)
  assert.equal(res.status, 400)
})

test('POST /prompt rejects an oversized image', async () => {
  const { router } = setup(new MemoryImagePersistence())
  const id = await createIdle(router)
  // ~2MB of base64 → ~1.5MB decoded, above the per-image cap.
  const huge = 'data:image/png;base64,' + 'A'.repeat(2_200_000)
  const res = await router('POST', `/sessions/${id}/prompt`, { prompt: 'x', images: [huge] }, AUTH)
  assert.equal(res.status, 400)
})

// ---- GET image route ----

class MockRes {
  status = 0
  headers: Record<string, unknown> = {}
  body?: Buffer
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers }
  end(buf?: Buffer) { this.body = buf }
}

test('GET image route returns bytes with content-type', async () => {
  const persistence = new MemoryImagePersistence()
  const { manager, router } = setup(persistence)
  const rec = manager.createSession({ cwd: '/tmp/work' })
  manager.run(rec.id, 'look', [PNG_DATA_URL])
  const userEv = manager.getEvents(rec.id, 0)!.events.find((e) => e.type === 'user')!
  const imgId = (userEv.data.imageIds as string[])[0]!

  const res = new MockRes()
  const out = await router('GET', `/sessions/${rec.id}/images/${imgId}`, {}, AUTH, res as never)
  assert.equal(out.handled, true)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'image/png')
  assert.deepEqual(res.body, Buffer.from(PNG_1PX_B64, 'base64'))
})

test('GET image route 404s a missing image', async () => {
  const { manager, router } = setup(new MemoryImagePersistence())
  const rec = manager.createSession({ cwd: '/tmp/work' })
  const res = new MockRes()
  const out = await router('GET', `/sessions/${rec.id}/images/missing`, {}, AUTH, res as never)
  assert.equal(out.status, 404)
})
