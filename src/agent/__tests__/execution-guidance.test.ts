import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExecutionGuidance } from '../execution-guidance.js'

test('builds anchor-first guidance for repeated edit failure', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'blocked',
    trajectory: [
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/a.ts', status: 'failed', errorClass: 'assertion' },
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance.target, 'src/a.ts')
  assert.equal(guidance.operation, 'edit_file')
  assert.match(guidance.message, /Target: src\/a\.ts/)
  assert.match(guidance.message, /Operation: edit_file/)
  assert.match(guidance.message, /Do not repeat the same edit_file input/)
  assert.match(guidance.message, /read_file/)
})

test('builds soft warning guidance before blocked level', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'warn',
    trajectory: [
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance.severity, 'warn')
  assert.match(guidance.message, /Verification signal/)
})

test('returns null when no doom loop signal exists', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'none',
    trajectory: [
      { tool: 'read_file', target: 'src/a.ts', status: 'success' },
    ],
  })

  assert.equal(guidance, null)
})
