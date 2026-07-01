import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tasksForSchedule,
  latestStatusForSchedule,
  isCancellable,
  isTerminalStatus,
  statusTone,
} from '../automations.ts'
import type { TaskRecord } from '../../runtime/types.ts'

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

test('statusTone maps to color classes', () => {
  assert.equal(statusTone('completed'), 'green')
  assert.equal(statusTone('failed'), 'red')
  assert.equal(statusTone('running'), 'yellow')
  assert.equal(statusTone('cancelled'), 'muted')
})
