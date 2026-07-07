import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks) { return Promise.resolve() }
  abort() {}
  listArtifacts() { return [] as Artifact[] }
  readArtifact(_id: string) { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]) {}
  rewindToMessages(_msgs: OaiMessage[]) {}
}

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-hooks-'))
  const manager = new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: cwd,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, router, cwd }
}

function cleanup(cwd: string) {
  rmSync(cwd, { recursive: true, force: true })
}

test('GET /sessions/:id/hooks returns 404 for missing session', async () => {
  const { router, cwd } = setup()
  try {
    const res = await router('GET', '/sessions/nope/hooks', {}, AUTH)
    assert.equal(res.status, 404)
  } finally { cleanup(cwd) }
})

test('GET /sessions/:id/hooks returns empty hooks when file absent', async () => {
  const { router, manager, cwd } = setup()
  try {
    const s = manager.createSession({})
    const res = await router('GET', `/sessions/${s.id}/hooks`, {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { hooks: [] })
  } finally { cleanup(cwd) }
})

test('PUT /sessions/:id/hooks writes and returns valid hooks', async () => {
  const { router, manager, cwd } = setup()
  try {
    const s = manager.createSession({})
    const payload = {
      hooks: [
        { event: 'postTool', script: './scripts/post-tool.sh' },
        { event: 'onError', script: './scripts/error.sh', timeoutMs: 3000 },
      ],
    }
    const res = await router('PUT', `/sessions/${s.id}/hooks`, payload, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, payload)

    const path = join(cwd, '.rivet', 'hooks.json')
    assert.equal(existsSync(path), true)
    const saved = JSON.parse(readFileSync(path, 'utf-8'))
    assert.deepEqual(saved, payload)
  } finally { cleanup(cwd) }
})

test('PUT /sessions/:id/hooks rejects invalid event', async () => {
  const { router, manager, cwd } = setup()
  try {
    const s = manager.createSession({})
    const res = await router('PUT', `/sessions/${s.id}/hooks`, {
      hooks: [{ event: 'badEvent', script: './x.sh' }],
    }, AUTH)
    assert.equal(res.status, 400)
  } finally { cleanup(cwd) }
})

test('PUT /sessions/:id/hooks rejects missing hooks array', async () => {
  const { router, manager, cwd } = setup()
  try {
    const s = manager.createSession({})
    const res = await router('PUT', `/sessions/${s.id}/hooks`, {}, AUTH)
    assert.equal(res.status, 400)
  } finally { cleanup(cwd) }
})

test('GET /sessions/:id/hooks reflects saved config', async () => {
  const { router, manager, cwd } = setup()
  try {
    const s = manager.createSession({})
    const payload = { hooks: [{ event: 'preTurn', script: './pre.sh' }] }
    await router('PUT', `/sessions/${s.id}/hooks`, payload, AUTH)
    const res = await router('GET', `/sessions/${s.id}/hooks`, {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, payload)
  } finally { cleanup(cwd) }
})

test('hooks routes are Bearer-gated', async () => {
  const { router, manager, cwd } = setup()
  try {
    const s = manager.createSession({})
    const get = await router('GET', `/sessions/${s.id}/hooks`, {}, {})
    assert.equal(get.status, 401)
    const put = await router('PUT', `/sessions/${s.id}/hooks`, { hooks: [] }, {})
    assert.equal(put.status, 401)
  } finally { cleanup(cwd) }
})
