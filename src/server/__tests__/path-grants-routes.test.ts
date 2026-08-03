import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// path-grants 的 RIVET_DIR 是模块首次加载时的快照——必须动态 import 整个
// server 链（config-routes 静态 import path-grants），确保 home 隔离生效。
// 因此本文件不静态 import 任何会触达 path-grants 的模块。

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const prevHome = process.env.RIVET_HOME
let home = ''
let workspace = ''
let target = ''
let router: (method: string, path: string, body?: unknown, reqHeaders?: Record<string, string>, res?: import('node:http').ServerResponse) => Promise<{ status: number; body?: unknown }>

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'rivet-grants-routes-'))
  process.env.RIVET_HOME = home
  workspace = mkdtempSync(join(tmpdir(), 'rivet-grants-ws-'))
  target = mkdtempSync(join(tmpdir(), 'rivet-grants-target-'))

  const { createRouter } = await import('../index.js')
  const { buildConfigRoutes } = await import('../config-routes.js')
  router = createRouter(buildConfigRoutes(TOKEN))
})

after(() => {
  if (prevHome === undefined) delete process.env.RIVET_HOME
  else process.env.RIVET_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

function seedGrant(path: string, mode: 'read' | 'write') {
  // 动态 import：home 已设置，RIVET_DIR 落在隔离目录
  return import('../../tools/path-grants.js').then(({ grantPath }) => {
    grantPath(path, mode, { persist: true, cwd: workspace })
  })
}

test('GET /config/path-grants: empty store returns an empty list', async () => {
  const res = await router('GET', `/config/path-grants?cwd=${encodeURIComponent(workspace)}`, {}, AUTH)
  assert.equal(res.status, 200)
  assert.deepEqual((res.body as { grants: unknown[] }).grants, [])
})

test('GET /config/path-grants: lists remembered grants with mode and existence', async () => {
  await seedGrant(target, 'write')
  const res = await router('GET', `/config/path-grants?cwd=${encodeURIComponent(workspace)}`, {}, AUTH)
  assert.equal(res.status, 200)
  const grants = (res.body as { grants: Array<{ path: string; mode: string; exists: boolean }> }).grants
  assert.equal(grants.length, 1)
  assert.equal(grants[0]!.mode, 'write')
  assert.equal(grants[0]!.exists, true)
  // 已删除的目录仍列出但标记 exists=false（撤销面仍可见）
  const ghost = join(target, 'gone')
  rmSync(target, { recursive: true, force: true })
  const res2 = await router('GET', `/config/path-grants?cwd=${encodeURIComponent(workspace)}`, {}, AUTH)
  const grants2 = (res2.body as { grants: Array<{ path: string; mode: string; exists: boolean }> }).grants
  assert.equal(grants2[0]!.exists, false, 'deleted root must be listed as not existing')
  mkdirSync(target, { recursive: true })
})

test('GET /config/path-grants: requires an absolute cwd', async () => {
  const res = await router('GET', '/config/path-grants?cwd=relative/path', {}, AUTH)
  assert.equal(res.status, 400)
})

test('DELETE /config/path-grants: revokes a remembered grant and persists the revocation', async () => {
  await seedGrant(target, 'write')
  const res = await router('DELETE', `/config/path-grants?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(target)}`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { ok: boolean; removed: boolean }
  assert.equal(body.ok, true)
  assert.equal(body.removed, true)

  // 磁盘同步失效：模拟新会话重载
  const { _resetGrantsForTest, loadPersistedGrants, isWriteGranted } = await import('../../tools/path-grants.js')
  _resetGrantsForTest()
  loadPersistedGrants(workspace)
  assert.equal(isWriteGranted(join(target, 'x')), false, 'revoked grant must not hydrate')

  // 再撤一次 → removed=false（幂等）
  const res2 = await router('DELETE', `/config/path-grants?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(target)}`, {}, AUTH)
  assert.equal((res2.body as { removed: boolean }).removed, false)
})

test('DELETE /config/path-grants: requires cwd and path', async () => {
  const noCwd = await router('DELETE', `/config/path-grants?path=${encodeURIComponent(target)}`, {}, AUTH)
  assert.equal(noCwd.status, 400)
  const noPath = await router('DELETE', `/config/path-grants?cwd=${encodeURIComponent(workspace)}`, {}, AUTH)
  assert.equal(noPath.status, 400)
})

test('path-grants routes reject unauthorized requests', async () => {
  const get = await router('GET', `/config/path-grants?cwd=${encodeURIComponent(workspace)}`, {}, {})
  assert.equal(get.status, 401)
  const del = await router('DELETE', `/config/path-grants?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(target)}`, {}, {})
  assert.equal(del.status, 401)
})
