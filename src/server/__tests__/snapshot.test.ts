/**
 * P1-4 — read-only session snapshots: builder, redaction, routes.
 *
 * Anti-proof table:
 *   #1 "snapshot includes raw transcripts" → test 1 asserts tool rows are dropped.
 *   #2 "redaction is cosmetic" → test 1/3 assert the secret is actually replaced.
 *   #3 "import trusts any file" → test 4 asserts version/shape validation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { buildSessionSnapshot } from '../session-snapshot.js'
import { redactSnapshotText } from '../snapshot-redact.js'
import { SessionPersist } from '../../agent/session-persist.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

process.env.RIVET_SESSION_DIR = mkdtempSync(join(tmpdir(), 'rivet-snapshot-sessions-'))

class SnapshotAgent implements ManagedAgent {
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
    createAgent: () => new SnapshotAgent(),
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router }
}

async function makeSession(manager: RuntimeSessionManager) {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-snapshot-cwd-'))
  const rec = manager.createSession({ cwd, title: 'Secret review' })
  const persist = new SessionPersist(rec.id, cwd)
  const messages: OaiMessage[] = [
    { role: 'user', content: 'Fix the auth flow' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: '{"path":"src/auth.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'patch applied' },
    {
      role: 'assistant',
      content: 'Done. Keep the key in env: sk-abcdef1234567890ABCDEF',
      reasoning_content: 'Use process.env.AUTH_TOKEN=abc123',
    },
  ]
  for (const m of messages) await persist.appendOaiWithChecksum(m)
  await persist.flushSessionBuffer()
  return { rec, cwd }
}

test('#1 snapshot drops tool traffic and redacts secrets', async () => {
  const { manager } = setup()
  const { rec, cwd } = await makeSession(manager)
  try {
    const events = manager.getEvents(rec.id, 0)!.events
    const { snapshot, findings } = await buildSessionSnapshot(rec, events, { includeReasoning: true })
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.messages.length, 2, 'tool/tool_result rows never enter snapshots')
    assert.equal(snapshot.messages[0]!.role, 'user')
    assert.equal(snapshot.messages[1]!.role, 'assistant')
    assert.match(snapshot.messages[1]!.text, /<redacted:api_key>/)
    assert.ok(!snapshot.messages[1]!.text.includes('sk-abcdef'))
    assert.match(snapshot.messages[1]!.reasoningSummary ?? '', /<redacted:password>/)
    assert.equal(snapshot.redaction.findings, findings)
    assert.ok(findings >= 2)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#2 redaction covers bearer/jwt/private-key heuristics', () => {
  const raw = [
    'Authorization: Bearer abcdef1234567890ABCDEF',
    'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const { text, findings } = redactSnapshotText(raw)
  assert.ok(findings >= 3)
  assert.ok(!text.includes('Bearer abcdef'))
  assert.ok(!text.includes('BEGIN RSA PRIVATE KEY'))
})

test('#3 POST /sessions/:id/snapshot/export returns the redacted document', async () => {
  const { manager, router } = setup()
  const { rec, cwd } = await makeSession(manager)
  try {
    const res = await router('POST', `/sessions/${rec.id}/snapshot/export`, { includeFileChanges: false }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { snapshot?: { messages?: unknown[]; redaction?: { findings?: number } } }
    assert.ok(Array.isArray(body.snapshot?.messages))
    assert.ok((body.snapshot?.redaction?.findings ?? 0) > 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#4 snapshot import validates version, shape and size', async () => {
  const { manager, router } = setup()
  const rec = manager.createSession({ cwd: '/tmp' })
  const dir = mkdtempSync(join(tmpdir(), 'rivet-snapshot-import-'))
  try {
    const valid = join(dir, 'ok.json')
    writeFileSync(valid, JSON.stringify({
      version: 1,
      meta: { title: 'Imported' },
      messages: [{ role: 'user', text: 'hi' }],
      redaction: { findings: 0, appliedAt: 0 },
    }))
    const ok = await router('POST', `/sessions/${rec.id}/snapshot/import`, { path: valid }, AUTH)
    assert.equal(ok.status, 200)

    const badVersion = join(dir, 'bad.json')
    writeFileSync(badVersion, JSON.stringify({ version: 2, meta: {}, messages: [] }))
    const bad = await router('POST', `/sessions/${rec.id}/snapshot/import`, { path: badVersion }, AUTH)
    assert.equal(bad.status, 400)

    const missing = await router('POST', `/sessions/${rec.id}/snapshot/import`, { path: join(dir, 'nope.json') }, AUTH)
    assert.equal(missing.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
