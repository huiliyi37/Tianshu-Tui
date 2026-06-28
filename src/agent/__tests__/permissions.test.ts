import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied, createPermissionOverlay } from '../permissions.js'

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

  it('wildcard does not match across shell operators (security#3)', () => {
    const rules = [{ tool: 'bash', params: { command: 'git status*' } }]
    // Normal args still work
    assert.equal(isToolAllowed('bash', { command: 'git status --short' }, rules), true)
    // Shell operators must NOT match via wildcard
    assert.equal(isToolAllowed('bash', { command: 'git status&&curl evil' }, rules), false)
    assert.equal(isToolAllowed('bash', { command: 'git status; rm -rf /' }, rules), false)
    assert.equal(isToolAllowed('bash', { command: 'git status | tee log' }, rules), false)
    assert.equal(isToolAllowed('bash', { command: 'git status$(whoami)' }, rules), false)
    // Tool name wildcards still work (no shell operators in tool names)
    assert.equal(isToolAllowed('read_file', {}, [{ tool: 'read_*' }]), true)
    assert.equal(isToolAllowed('grep', { pattern: 'x' }, [{ tool: 'read_*' }]), false)
  })
})

describe('isBashCommandAllowlisted', () => {
  it('matches single-word allowlist entries', () => {
    assert.equal(isBashCommandAllowlisted('npm test', ['npm']), true)
    assert.equal(isBashCommandAllowlisted('npm', ['npm']), true)
    assert.equal(isBashCommandAllowlisted('npmfoo', ['npm']), false)
  })

  it('rejects shell operators after allowlisted prefix', () => {
    assert.equal(isBashCommandAllowlisted('npm && rm -rf /', ['npm']), false)
    assert.equal(isBashCommandAllowlisted('npm; rm -rf /', ['npm']), false)
    assert.equal(isBashCommandAllowlisted('npm | tee log', ['npm']), false)
  })

  it('matches multi-word allowlist entries', () => {
    assert.equal(isBashCommandAllowlisted('git status --short', ['git status']), true)
    assert.equal(isBashCommandAllowlisted('git status', ['git status']), true)
    assert.equal(isBashCommandAllowlisted('git status&&rm', ['git status']), false)
  })

  it('returns false for empty or missing allowlist', () => {
    assert.equal(isBashCommandAllowlisted('npm test', []), false)
    assert.equal(isBashCommandAllowlisted('npm test', undefined), false)
    assert.equal(isBashCommandAllowlisted('', ['npm']), false)
  })
})

describe('permission deny rules', () => {
  it('blocks tool calls matching deny rules', () => {
    assert.equal(isToolDenied('bash', { command: 'rm -rf /' }, [
      { tool: 'bash', params: { command: 'rm -rf*' } },
    ]), true)
  })

  it('does not block calls that do not match deny rules', () => {
    assert.equal(isToolDenied('bash', { command: 'git status' }, [
      { tool: 'bash', params: { command: 'rm -rf*' } },
    ]), false)
  })
})

describe('isBashCommandDenied', () => {
  it('matches denylist prefixes and rejects shell operators', () => {
    assert.equal(isBashCommandDenied('rm -rf /tmp', ['rm']), true)
    assert.equal(isBashCommandDenied('rm -rf / && echo ok', ['rm']), false)
    assert.equal(isBashCommandDenied('git status', ['rm']), false)
  })
})

describe('createPermissionOverlay', () => {
  it('returns empty overlay', () => {
    const overlay = createPermissionOverlay()
    assert.deepEqual(overlay, { allow: [], deny: [], bashAllow: [], bashDeny: [] })
  })
})
