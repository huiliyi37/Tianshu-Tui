/**
 * /enter <worker> 工作区切换测试。
 *
 * 契约：
 *  1. 根据 worker id 或短标签解析到 worker。
 *  2. 无参数 / 未知 worker 返回清晰错误。
 *  3. 命中后生成让主 agent 调用 delegate_task resume 的 prompt。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'
import { resolveEnterWorkerInput } from '../../slash-commands.js'

function applyRunningWorker(app: any, workOrderId: string, progressLine: string) {
  app.fleet.apply({
    workOrderId,
    parentToolId: 'tool_abc',
    profile: 'code_scout',
    authority: 'tianquan',
    status: 'running',
    progressLine,
    timestamp: Date.now(),
  })
}

test('/enter 无参数返回使用说明', () => {
  const { app } = makeApp({ cols: 120, rows: 40 })
  const result = resolveEnterWorkerInput(app, '/enter')
  assert.ok(result && 'error' in result, 'returns error')
  assert.ok((result as { error: string }).error.includes('Usage'), 'usage hint')
})

test('/enter 未知 worker 返回错误', () => {
  const { app } = makeApp({ cols: 120, rows: 40 })
  const result = resolveEnterWorkerInput(app, '/enter unknown-id')
  assert.ok(result && 'error' in result, 'returns error')
  assert.ok((result as { error: string }).error.includes('not found'), 'not found message')
})

test('/enter <workOrderId> 生成 resume prompt', () => {
  const { app } = makeApp({ cols: 120, rows: 40 })
  applyRunningWorker(app, 'wo_team:T1', '⚙ grep auth')

  const result = resolveEnterWorkerInput(app, '/enter wo_team:T1')
  assert.ok(result && 'prompt' in result, 'returns prompt')
  const prompt = (result as { prompt: string }).prompt
  assert.ok(prompt.includes('Resume worker wo_team:T1'), `prompt header: ${prompt}`)
  assert.ok(prompt.includes('profile: code_scout'), `profile: ${prompt}`)
  assert.ok(prompt.includes('Previous objective: ⚙ grep auth'), `prior objective: ${prompt}`)
  assert.ok(prompt.includes('delegate_task with resume="wo_team:T1"'), `resume param: ${prompt}`)
})

test('/enter <shortLabel> 解析为完整 worker id', () => {
  const { app } = makeApp({ cols: 120, rows: 40 })
  applyRunningWorker(app, 'wo_team:T2', '⚙ read files')

  const result = resolveEnterWorkerInput(app, '/enter T2 continue refactoring')
  assert.ok(result && 'prompt' in result, 'returns prompt')
  const prompt = (result as { prompt: string }).prompt
  assert.ok(prompt.includes('Resume worker wo_team:T2'), `full id: ${prompt}`)
  assert.ok(prompt.includes('Continue with: continue refactoring'), `continuation message: ${prompt}`)
  assert.ok(prompt.includes('objective="continue refactoring"'), `objective param: ${prompt}`)
})

test('/enter 无续作消息时使用默认 objective', () => {
  const { app } = makeApp({ cols: 120, rows: 40 })
  applyRunningWorker(app, 'wo_team:T3', '⚙ analyze')

  const result = resolveEnterWorkerInput(app, '/enter T3')
  assert.ok(result && 'prompt' in result, 'returns prompt')
  const prompt = (result as { prompt: string }).prompt
  assert.ok(prompt.includes('Continue from where you left off'), `default objective: ${prompt}`)
})
