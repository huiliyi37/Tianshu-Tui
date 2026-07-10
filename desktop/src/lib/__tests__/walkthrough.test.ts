import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWalkthrough, buildStepComment } from '../walkthrough.ts'

const VALID = JSON.stringify({
  version: 1,
  sessionId: 's1',
  createdAt: 1000,
  summary: { totalSteps: 2, failedSteps: 1, apps: ['Notes'], halted: true },
  steps: [
    { index: 1, turn: 1, ts: 1, action: 'launch_app', app: 'Notes', success: true },
    { index: 2, turn: 1, ts: 2, action: 'click', app: 'Notes', success: false, errorNote: 'requires explicit user approval' },
  ],
  markdown: '# 运行走查',
})

test('parseWalkthrough accepts a v1 document', () => {
  const doc = parseWalkthrough(VALID)
  assert.ok(doc)
  assert.equal(doc.steps.length, 2)
  assert.equal(doc.summary.halted, true)
  assert.equal(doc.steps[1]!.errorNote, 'requires explicit user approval')
})

test('parseWalkthrough rejects malformed input', () => {
  assert.equal(parseWalkthrough('not json'), null)
  assert.equal(parseWalkthrough('{}'), null)
  assert.equal(parseWalkthrough(JSON.stringify({ version: 2, steps: [] })), null)
  assert.equal(parseWalkthrough(JSON.stringify({ version: 1, steps: 'x', summary: {} })), null)
})

test('buildStepComment joins anchor + trimmed comment', () => {
  assert.equal(buildStepComment('[走查评论] 步骤 2', '  点错了按钮  '), '[走查评论] 步骤 2\n点错了按钮')
})
