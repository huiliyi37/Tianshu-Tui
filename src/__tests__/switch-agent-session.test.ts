/**
 * switchAgentSession — 运行时会话身份切换的确定性分支测试。
 *
 * 仅覆盖 createAgentRuntime 之前可确定性断言的分支(已在目标会话 / 跨 cwd 拒绝)。
 * 成功路径会整体重建 AgentLoop(重型依赖,与 switchAgentRuntime 同构),由真终端手验覆盖。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { switchAgentSession } from '../bootstrap.js'
import type { BootstrapContext } from '../bootstrap.js'
import { SessionPersist } from '../agent/session-persist.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rivet-switch-sess-'))
  process.env.RIVET_SESSION_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RIVET_SESSION_DIR
})

test('目标会话等于当前会话 → 拒绝,不重建', () => {
  const ctx = { sessionId: 'same-id', cwd: '/proj' } as unknown as BootstrapContext
  const res = switchAgentSession(ctx, 'same-id')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /已经在该会话/)
})

test('跨 cwd 的会话被拒绝载入', () => {
  const target = new SessionPersist('other-cwd-sess', dir)
  target.initMetadata({ cwd: '/some/other/project' })

  const ctx = { sessionId: 'current-id', cwd: '/proj/here' } as unknown as BootstrapContext
  const res = switchAgentSession(ctx, 'other-cwd-sess')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /其他工作目录/)
})
