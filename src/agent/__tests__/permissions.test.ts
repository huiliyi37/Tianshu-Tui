import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isToolAllowed } from '../permissions.js'

describe('permission allow rules', () => {
  it('matches exact tool names and exact parameter values', () => {
    assert.equal(isToolAllowed('read_file', { file_path: 'README.md' }, [
      { tool: 'read_file', params: { file_path: 'README.md' } },
    ]), true)
  })

  it('matches wildcard tool and parameter patterns', () => {
    assert.equal(isToolAllowed('read_file', { file_path: 'docs/guide.md' }, [
      { tool: 'read_*', params: { file_path: 'docs/*' } },
    ]), true)
  })

  it('matches bash command prefixes without matching unrelated commands', () => {
    const rules = [{ tool: 'bash', params: { command: 'git status*' } }]

    assert.equal(isToolAllowed('bash', { command: 'git status --short' }, rules), true)
    assert.equal(isToolAllowed('bash', { command: 'git reset --hard' }, rules), false)
  })

  it('rejects non-matching tools, missing params, and empty rules', () => {
    assert.equal(isToolAllowed('write_file', { file_path: 'README.md' }, [
      { tool: 'read_file', params: { file_path: 'README.md' } },
    ]), false)
    assert.equal(isToolAllowed('read_file', {}, [
      { tool: 'read_file', params: { file_path: 'README.md' } },
    ]), false)
    assert.equal(isToolAllowed('read_file', { file_path: 'README.md' }, []), false)
  })
})
