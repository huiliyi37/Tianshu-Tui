import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCard } from '../format/tool-card.js'
import { getTheme } from '../theme.js'

function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') }

const theme = getTheme()

// ── Streaming delegation preview: tasks[] visible during arg streaming ──

test('formatToolCard: delegate_batch streaming shows task items from toolInput', () => {
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      agent: 'task',
      context: 'shared background',
      tasks: [
        { id: 'AuthLoader', description: 'Load auth module' },
        { id: 'DbMigrator', description: 'Run DB migration' },
      ],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.toLowerCase().includes('delegat') || plain.toLowerCase().includes('batch'), 'header shows delegation verb')
  // Each task id should be visible in the streaming preview
  assert.ok(plain.includes('AuthLoader'), 'task 1 id visible during streaming')
  assert.ok(plain.includes('DbMigrator'), 'task 2 id visible during streaming')
})

test('formatToolCard: delegate_batch streaming shows task descriptions', () => {
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      agent: 'task',
      tasks: [
        { id: 'W1', description: 'Scan for vulnerabilities' },
      ],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('Scan for vulnerabilities'), 'task description visible')
})

test('formatToolCard: delegate_batch streaming handles partial tasks array (mid-stream)', () => {
  // During streaming, tasks[] may be partially parsed or have undefined fields
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      agent: 'task',
      tasks: [
        { id: 'W1', description: 'First task' },
        { id: '', description: '' }, // partial/garbage entry mid-stream
      ],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('W1'), 'first task visible')
  assert.ok(plain.includes('First task'), 'first task description visible')
  // Should not crash on partial entry — may show a placeholder or skip
  assert.ok(lines.length > 0, 'does not crash on partial entries')
})

test('formatToolCard: delegate_batch non-streaming (result) does NOT show task preview', () => {
  // When not streaming (result has arrived), the preview is redundant —
  // the worker fleet panel shows live status instead.
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: 'Dispatched 2 workers',
    streaming: false,
    toolInput: {
      agent: 'task',
      tasks: [{ id: 'W1', description: 'Should not appear in preview' }],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(!plain.includes('Should not appear in preview'), 'no task preview when not streaming')
})

test('formatToolCard: delegate_task (single) streaming shows objective preview', () => {
  const lines = formatToolCard({
    toolName: 'delegate_task',
    content: '',
    streaming: true,
    toolInput: {
      agent: 'task',
      objective: 'Explore the auth module and report back',
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('Explore the auth module'), 'objective visible during streaming')
})

test('formatToolCard: delegate_batch with empty tasks shows waiting indicator', () => {
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      agent: 'task',
      tasks: [],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  // Should show a "waiting for tasks..." hint, not crash
  assert.ok(lines.length > 0, 'renders without crash')
  assert.ok(plain.includes('…') || plain.includes('等待') || plain.includes('waiting'), 'shows waiting indicator')
})

test('formatToolCard: delegate_batch large batch truncated with count', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `W${i + 1}`, description: `Task ${i + 1}` }))
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: { agent: 'task', tasks },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('W1'), 'first task visible')
  assert.ok(plain.includes('+') || plain.includes('more') || plain.includes('…'), 'truncation indicator present')
  // Task 20 should NOT be visible (truncated)
  assert.ok(!plain.includes('W20'), '20th task truncated')
})
