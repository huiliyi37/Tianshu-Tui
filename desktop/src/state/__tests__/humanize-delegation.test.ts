import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeToolInput } from '../../state/event-reducer.js'

// ── humanizeToolInput: delegation tool rendering ───────────────

test('humanizeToolInput: delegate_batch renders task list summary', () => {
  const result = humanizeToolInput('delegate_batch', {
    agent: 'task',
    context: 'shared background',
    tasks: [
      { id: 'AuthLoader', description: 'Load auth module' },
      { id: 'DbMigrator', description: 'Run DB migration' },
    ],
  })
  // Should NOT be raw JSON dump
  assert.ok(!result.startsWith('{'), 'not raw JSON')
  // Should show task ids
  assert.ok(result.includes('AuthLoader'), 'task 1 id visible')
  assert.ok(result.includes('DbMigrator'), 'task 2 id visible')
})

test('humanizeToolInput: delegate_batch shows task descriptions', () => {
  const result = humanizeToolInput('delegate_batch', {
    agent: 'task',
    tasks: [{ id: 'Scanner', description: 'Scan for vulnerabilities' }],
  })
  assert.ok(result.includes('Scan for vulnerabilities'), 'description visible')
})

test('humanizeToolInput: delegate_batch handles empty tasks', () => {
  const result = humanizeToolInput('delegate_batch', {
    agent: 'task',
    tasks: [],
  })
  // Should show a hint, not raw JSON
  assert.ok(!result.startsWith('{'), 'not raw JSON for empty tasks')
  assert.ok(result.length > 0, 'renders something')
})

test('humanizeToolInput: delegate_batch handles missing tasks field', () => {
  const result = humanizeToolInput('delegate_batch', {
    agent: 'task',
  })
  assert.ok(!result.startsWith('{'), 'not raw JSON for missing tasks')
})

test('humanizeToolInput: delegate_batch truncates large batches', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `W${i + 1}`, description: `Task ${i + 1}` }))
  const result = humanizeToolInput('delegate_batch', {
    agent: 'task',
    tasks,
  })
  assert.ok(result.includes('W1'), 'first task visible')
  assert.ok(!result.includes('W20'), '20th task truncated')
  // Should show count of truncated tasks
  assert.ok(result.includes('+') || result.includes('more'), 'truncation count present')
})

test('humanizeToolInput: delegate_task renders objective', () => {
  const result = humanizeToolInput('delegate_task', {
    agent: 'task',
    objective: 'Explore the auth module and report back',
  })
  assert.ok(!result.startsWith('{'), 'not raw JSON')
  assert.ok(result.includes('Explore the auth module'), 'objective visible')
})

test('humanizeToolInput: delegate_task handles missing objective', () => {
  const result = humanizeToolInput('delegate_task', {
    agent: 'executor',
  })
  assert.ok(!result.startsWith('{'), 'not raw JSON for missing objective')
})

test('humanizeToolInput: delegate_batch handles partial/malformed task entries', () => {
  const result = humanizeToolInput('delegate_batch', {
    agent: 'task',
    tasks: [
      { id: 'W1', description: 'valid task' },
      { id: '', description: '' }, // empty entry
      { description: 'no id' }, // missing id
    ],
  })
  assert.ok(result.includes('W1'), 'valid task visible')
  assert.ok(result.includes('valid task'), 'valid description visible')
  assert.ok(!result.includes('undefined'), 'no undefined in output')
})

test('humanizeToolInput: existing tools still work (write_file)', () => {
  const result = humanizeToolInput('write_file', {
    path: '/foo/bar.ts',
    content: 'line1\nline2\nline3',
  })
  assert.ok(result.includes('/foo/bar.ts'))
  assert.ok(result.includes('3 行'))
})
