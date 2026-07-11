import { test } from 'node:test'
import assert from 'node:assert/strict'
import i18n from '../../i18n/index.ts'
import zhAutomations from '../../locales/zh-CN/automations.json'
import {
  tasksForSchedule,
  latestStatusForSchedule,
  isCancellable,
  isTerminalStatus,
  statusLabel,
  statusTone,
  trustStage,
  newlyGrantedApps,
  haltedAppFromError,
  loadDistillLinks,
  saveDistillLink,
  FIRST_RUNS_TRUST_THRESHOLD,
} from '../automations.ts'
import type { TaskRecord } from '../../runtime/types.ts'

// statusLabel resolves via the shared i18n singleton — init it with the zh-CN
// automations namespace so labels match the pre-i18n literals.
if (!i18n.isInitialized) {
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { automations: zhAutomations } },
    interpolation: { escapeValue: false },
  })
} else {
  i18n.addResourceBundle('zh-CN', 'automations', zhAutomations, true, true)
}

function rec(id: string, scheduledTaskId: string, createdAt: string, status: TaskRecord['status']): TaskRecord {
  return { id, prompt: 'p', source: 'cron', status, createdAt, scheduledTaskId }
}

const TASKS: TaskRecord[] = [
  rec('t1', 'cron_a', '2026-01-01T00:00:00Z', 'failed'),
  rec('t2', 'cron_a', '2026-01-02T00:00:00Z', 'completed'),
  rec('t3', 'cron_b', '2026-01-03T00:00:00Z', 'running'),
]

test('tasksForSchedule filters + sorts newest first', () => {
  const runs = tasksForSchedule(TASKS, 'cron_a')
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.id, 't2')
  assert.equal(runs[1]!.id, 't1')
})

test('latestStatusForSchedule returns most recent run status', () => {
  assert.equal(latestStatusForSchedule(TASKS, 'cron_a'), 'completed')
  assert.equal(latestStatusForSchedule(TASKS, 'cron_b'), 'running')
  assert.equal(latestStatusForSchedule(TASKS, 'cron_missing'), null)
})

test('isCancellable only for active runs', () => {
  assert.equal(isCancellable('running'), true)
  assert.equal(isCancellable('pending'), true)
  assert.equal(isCancellable('completed'), false)
  assert.equal(isCancellable('failed'), false)
})

test('isTerminalStatus', () => {
  assert.equal(isTerminalStatus('completed'), true)
  assert.equal(isTerminalStatus('running'), false)
})

test('statusLabel resolves through i18n (zh-CN)', () => {
  assert.equal(statusLabel('completed'), '成功')
  assert.equal(statusLabel('failed'), '失败')
  assert.equal(statusLabel('pending'), '排队中')
})

test('statusTone maps to color classes', () => {
  assert.equal(statusTone('completed'), 'green')
  assert.equal(statusTone('failed'), 'red')
  assert.equal(statusTone('running'), 'yellow')
  assert.equal(statusTone('cancelled'), 'muted')
})

// ── 试跑驱动信任 ──────────────────────────────────────────────

test('trustStage: always-review/缺省无信任阶段', () => {
  assert.equal(trustStage({ triggerCount: 5 }), null)
  assert.equal(trustStage({ reviewPolicy: 'always-review', triggerCount: 5 }), null)
})

test('trustStage: first-runs 未试跑→建立中→已建立', () => {
  assert.equal(trustStage({ reviewPolicy: 'first-runs', triggerCount: 0 }), 'untried')
  assert.equal(trustStage({ reviewPolicy: 'first-runs', triggerCount: 1 }), 'building')
  assert.equal(
    trustStage({ reviewPolicy: 'first-runs', triggerCount: FIRST_RUNS_TRUST_THRESHOLD - 1 }),
    'building',
  )
  assert.equal(
    trustStage({ reviewPolicy: 'first-runs', triggerCount: FIRST_RUNS_TRUST_THRESHOLD }),
    'trusted',
  )
})

test('trustStage: auto-proceed 恒无人值守', () => {
  assert.equal(trustStage({ reviewPolicy: 'auto-proceed', triggerCount: 0 }), 'unattended')
})

test('newlyGrantedApps diffs 新增授权', () => {
  assert.deepEqual(newlyGrantedApps([], ['Safari']), ['Safari'])
  assert.deepEqual(newlyGrantedApps(['Safari'], ['Safari', 'Notes']), ['Notes'])
  assert.deepEqual(newlyGrantedApps(['Safari', 'Notes'], ['Safari']), [])
  assert.deepEqual(newlyGrantedApps([], []), [])
})

test('distill links 读写 roundtrip 且损坏数据回空表', () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  assert.deepEqual(loadDistillLinks(storage), {})
  const links = saveDistillLink('rec-1', { sessionId: 's1', workflowPath: '.rivet/recordings/rec-1.workflow.md' }, storage)
  assert.equal(links['rec-1']!.sessionId, 's1')
  assert.deepEqual(loadDistillLinks(storage), links)
  // 追加第二条不丢第一条
  saveDistillLink('rec-2', { sessionId: 's2', workflowPath: 'w2.md' }, storage)
  const all = loadDistillLinks(storage)
  assert.equal(Object.keys(all).length, 2)
  // 损坏数据回空表
  store.set('rivet.recorder.distillLinks', '{broken')
  assert.deepEqual(loadDistillLinks(storage), {})
})

test('haltedAppFromError 从 halt 文案提取 app 名', () => {
  assert.equal(
    haltedAppFromError('unattended run blocked on approval: computer_use (app: Safari)'),
    'Safari',
  )
  assert.equal(
    haltedAppFromError('[unattended halt] unattended run blocked on approval: computer_use (app: Google Chrome)'),
    'Google Chrome',
  )
  assert.equal(haltedAppFromError('unattended run blocked on approval: bash'), null)
  assert.equal(haltedAppFromError('ordinary error'), null)
  assert.equal(haltedAppFromError(undefined), null)
})
