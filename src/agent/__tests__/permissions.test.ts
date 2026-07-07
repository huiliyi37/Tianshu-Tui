import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied, createPermissionOverlay, learnFileApproval } from '../permissions.js'

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
  it('denies a matching prefix in any command segment (fail-closed)', () => {
    assert.equal(isBashCommandDenied('rm -rf /tmp', ['rm']), true)
    // Shell chaining must NOT bypass the denylist — a denied prefix in ANY
    // segment blocks the whole command (regression: the old impl reused the
    // allowlist logic and returned false here, letting the command through).
    assert.equal(isBashCommandDenied('rm -rf / && echo ok', ['rm']), true)
    assert.equal(isBashCommandDenied('echo ok; rm -rf /', ['rm']), true)
    // The exact command that killed the sidecar in the field report.
    assert.equal(isBashCommandDenied('taskkill //F //IM node.exe 2>/dev/null; sleep 1; echo killed', ['taskkill']), true)
    // Subshell / command-substitution bodies are scanned too.
    assert.equal(isBashCommandDenied('foo $(rm -rf /)', ['rm']), true)
    // Non-matching command binary → not denied.
    assert.equal(isBashCommandDenied('git status', ['rm']), false)
    // A denied word as an argument (not the command) must NOT match.
    assert.equal(isBashCommandDenied('echo taskkill', ['taskkill']), false)
    // Token boundary: `rm` must not match `rmdir`.
    assert.equal(isBashCommandDenied('rmdir foo', ['rm']), false)
    // Leading env assignment does not hide the denied command.
    assert.equal(isBashCommandDenied('FOO=bar rm -rf /', ['rm']), true)
    // Empty command / empty denylist → not denied.
    assert.equal(isBashCommandDenied('', ['rm']), false)
    assert.equal(isBashCommandDenied('rm -rf /', []), false)
  })
})

describe('createPermissionOverlay', () => {
  it('returns empty overlay', () => {
    const overlay = createPermissionOverlay()
    assert.deepEqual(overlay, { allow: [], deny: [], bashAllow: [], bashDeny: [] })
  })
})

describe('learnFileApproval', () => {
  it('adds a file-scoped allow rule that matches the exact path afterwards', () => {
    const overlay = createPermissionOverlay()
    learnFileApproval('edit_file', 'src/foo.ts', overlay)
    assert.equal(overlay.allow.length, 1)
    assert.equal(isToolAllowed('edit_file', { file_path: 'src/foo.ts' }, overlay.allow), true)
    // A different file is NOT auto-allowed by the learned rule.
    assert.equal(isToolAllowed('edit_file', { file_path: 'src/bar.ts' }, overlay.allow), false)
  })

  it('dedupes repeated approvals of the same tool+file', () => {
    const overlay = createPermissionOverlay()
    learnFileApproval('write_file', 'a.ts', overlay)
    learnFileApproval('write_file', 'a.ts', overlay)
    assert.equal(overlay.allow.length, 1)
  })

  it('no-ops on empty path or missing overlay', () => {
    const overlay = createPermissionOverlay()
    learnFileApproval('edit_file', '', overlay)
    assert.equal(overlay.allow.length, 0)
    assert.doesNotThrow(() => learnFileApproval('edit_file', 'a.ts', undefined))
  })
})
