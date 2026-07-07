/**
 * Worker Detail 内容构建器测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildWorkerDetailContent } from '../worker-detail.js'
import { SessionPersist, getSessionDir } from '../../agent/session-persist.js'
import type { FleetWorkerView } from '../fleet-registry.js'

function tmpCwd(): string {
  return process.cwd()
}

async function seedWorkerSession(workerId: string, cwd: string): Promise<void> {
  const sessionId = `worker-${workerId.replace(/:/g, '-')}`
  const dir = getSessionDir(cwd)
  mkdirSync(dir, { recursive: true })
  const persist = new SessionPersist(sessionId, cwd)
  // appendOaiWithChecksum 是异步落盘 — 必须 await，否则后续同步 loadOai 读到空文件
  await persist.appendOaiWithChecksum({ role: 'user', content: `Objective for ${workerId}` })
  await persist.appendOaiWithChecksum({ role: 'assistant', content: 'I will investigate.' })
  await persist.appendOaiWithChecksum({ role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"src/x.ts"}' } }] })
  await persist.appendOaiWithChecksum({ role: 'tool', tool_call_id: 'tc1', content: 'export const x = 1' })
}

function seedWorkerResult(workerId: string): void {
  const dir = join(process.env.HOME ?? '/tmp', '.rivet', 'subagents')
  mkdirSync(dir, { recursive: true })
  const result = {
    workOrderId: workerId,
    status: 'passed',
    summary: 'Found the issue.',
    findings: [],
    artifacts: [{ kind: 'note', title: 'Key finding', content: 'The bug is on line 42.' }],
    patchSummary: '',
    changedFiles: ['src/x.ts'],
    examinedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    model: 'deepseek-v4',
    provider: 'deepseek',
    usage: { input_tokens: 100, output_tokens: 50 },
  }
  writeFileSync(join(dir, `${workerId}.json`), JSON.stringify(result, null, 2))
}

test('buildWorkerDetailContent includes header, result, and transcript', async () => {
  const workerId = 'wo_team:T1'
  const cwd = tmpCwd()
  await seedWorkerSession(workerId, cwd)
  seedWorkerResult(workerId)

  const liveView: FleetWorkerView = {
    workerId,
    shortLabel: 'T1',
    parentToolId: 'tool_a',
    profile: 'reviewer',
    authority: 'tianquan',
    status: 'passed',
    panelStatus: 'done',
    terminal: true,
    activity: 'done',
    activityLog: ['⚙ read_file', '✓ done'],
    elapsedMs: 1200,
    toolUseCount: 0,
    tokenCount: 0,
    unread: false,
  }

  const { content, title, messages } = buildWorkerDetailContent(workerId, cwd, liveView)

  assert.ok(title.includes('T1'))
  assert.ok(content.includes('wo_team:T1'))
  assert.ok(content.includes('reviewer'))
  assert.ok(content.includes('tianquan'))
  assert.ok(content.includes('Found the issue.'))
  assert.ok(content.includes('src/x.ts'))
  assert.ok(content.includes('The bug is on line 42.'))
  assert.ok(content.includes('Objective for wo_team:T1'))
  assert.ok(content.includes('read_file'))
  assert.ok(messages.length > 0, 'messages parsed for search')
})

test('buildWorkerDetailContent degrades when result/session missing', () => {
  const workerId = 'wo_missing_xxx'
  const cwd = tmpCwd()
  const { content, title } = buildWorkerDetailContent(workerId, cwd)
  assert.ok(title.includes('missing_xxx'))
  assert.ok(content.includes('unknown') || content.includes('worker transcript not available'))
})

// Cleanup test result files to avoid leaking into real subagent cache.
test('cleanup worker-detail test artifacts', () => {
  const dir = join(process.env.HOME ?? '/tmp', '.rivet', 'subagents')
  try {
    rmSync(join(dir, 'wo_team:T1.json'))
  } catch { /* ignore */ }
})
