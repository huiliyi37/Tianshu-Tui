import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { RECORDING_SCHEMA_VERSION } from '../../prompt/rpa-distill.js'
import type { Config } from '../../config/schema.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  prompts: string[] = []
  artifacts: Artifact[] = []
  private resolveRun?: () => void
  run(prompt: string, cb: AgentCallbacks) {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  finish() { this.resolveRun?.() }
  abort() { this.resolveRun?.() }
  listArtifacts() { return this.artifacts }
  readArtifact() { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup(config?: Config) {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN, undefined, config))
  return { manager, agents, router }
}

const HEADER = JSON.stringify({ schema: RECORDING_SCHEMA_VERSION, startedAt: 1, platform: 'darwin' })
const CLICK = JSON.stringify({
  ts: 100, type: 'click', app: 'QQ',
  data: { x: 1, y: 2, button: 'left', count: 1, element: { role: 'AXButton', title: '发送', value: '', ancestors: [] } },
})
const JSONL = [HEADER, CLICK].join('\n')

test('distill 路由创建蒸馏会话，prompt 含时间线与工作流路径', async () => {
  const { agents, router } = setup()
  const res = await router('POST', '/recordings/distill', { recordingId: 'rec-abc', jsonl: JSONL }, AUTH)
  assert.equal(res.status, 201)
  const body = res.body as { session: { id: string }; workflowPath: string; eventCount: number; apps: string[] }
  assert.equal(body.workflowPath, '.rivet/recordings/rec-abc.workflow.md')
  assert.equal(body.eventCount, 1)
  assert.deepEqual(body.apps, ['QQ'])
  // createSession 带 prompt → agent 立刻收到蒸馏任务
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(agents.length, 1)
  const prompt = agents[0]!.prompts[0]!
  assert.match(prompt, /AXButton/)
  assert.match(prompt, /\.rivet\/recordings\/rec-abc\.workflow\.md/)
  assert.match(prompt, /验证步骤/)
})

test('distill 路由缺字段与坏 schema 返回 400', async () => {
  const { router } = setup()
  const missing = await router('POST', '/recordings/distill', { recordingId: 'x' }, AUTH)
  assert.equal(missing.status, 400)
  const badSchema = await router(
    'POST', '/recordings/distill',
    { recordingId: 'x', jsonl: JSON.stringify({ schema: 'other/1' }) + '\n' + CLICK },
    AUTH,
  )
  assert.equal(badSchema.status, 400)
  assert.match(String((badSchema.body as { error: string }).error), /unsupported_schema/)
})

test('distill 路由清洗 recordingId 防路径注入', async () => {
  const { router } = setup()
  const res = await router('POST', '/recordings/distill', { recordingId: '../../etc/passwd', jsonl: JSONL }, AUTH)
  // 清洗后剩 "etcpasswd" —— 不含路径分隔符
  assert.equal(res.status, 201)
  const body = res.body as { workflowPath: string }
  assert.ok(!body.workflowPath.includes('..'))
  assert.match(body.workflowPath, /^\.rivet\/recordings\/[a-zA-Z0-9_-]+\.workflow\.md$/)
})

test('distill 路由 Pro 门禁：computerUse 未启用时 403 pro_required', async () => {
  const disabled: Config = {
    ...DEFAULT_CONFIG,
    pro: { ...DEFAULT_CONFIG.pro, enabled: false },
  }
  const { router } = setup(disabled)
  const prevEnv = process.env.RIVET_PRO
  delete process.env.RIVET_PRO
  try {
    const res = await router('POST', '/recordings/distill', { recordingId: 'r', jsonl: JSONL }, AUTH)
    assert.equal(res.status, 403)
    assert.equal((res.body as { error: string }).error, 'pro_required')
  } finally {
    if (prevEnv !== undefined) process.env.RIVET_PRO = prevEnv
  }
})

test('distill 路由 Pro 门禁：Pro 启用时放行', async () => {
  const enabled: Config = {
    ...DEFAULT_CONFIG,
    pro: { ...DEFAULT_CONFIG.pro, enabled: true },
  }
  const { router } = setup(enabled)
  const res = await router('POST', '/recordings/distill', { recordingId: 'r', jsonl: JSONL }, AUTH)
  assert.equal(res.status, 201)
})
