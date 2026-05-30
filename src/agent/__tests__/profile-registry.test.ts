import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProfileRegistry } from '../profile-registry.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `rivet-test-agents-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('ProfileRegistry', () => {
  let registry: ProfileRegistry

  beforeEach(() => {
    registry = new ProfileRegistry()
  })

  it('has 6 built-in profiles', () => {
    assert.equal(registry.list().length, 6)
  })

  it('maps code_scout as readonly', () => {
    const p = registry.get('code_scout')!
    assert.ok(p)
    assert.equal(p.role, 'readonly')
    assert.equal(p.builtIn, true)
  })

  it('maps patcher as hands with write tools', () => {
    const p = registry.get('patcher')!
    assert.ok(p)
    assert.equal(p.role, 'hands')
    assert.ok(p.allowedTools.includes('edit_file'))
    assert.ok(p.allowedTools.includes('write_file'))
    assert.ok(p.allowedTools.includes('bash'))
  })

  it('maps planner as brain with delegate tools', () => {
    const p = registry.get('planner')!
    assert.ok(p)
    assert.equal(p.role, 'brain')
    assert.ok(p.allowedTools.includes('delegate_task'))
    assert.ok(p.allowedTools.includes('delegate_batch'))
  })

  it('maps verifier as hands with defaultKind=verify', () => {
    const p = registry.get('verifier')!
    assert.ok(p)
    assert.equal(p.role, 'hands')
    assert.equal(p.defaultKind, 'verify')
    assert.equal(p.defaultMaxTokens, 16384)
  })

  it('listWriteProfiles returns hands roles', () => {
    const write = registry.listWriteProfiles()
    assert.deepEqual(write.sort(), ['patcher', 'verifier'])
  })

  it('listReadOnlyProfiles returns readonly roles', () => {
    const ro = registry.listReadOnlyProfiles()
    assert.deepEqual(ro.sort(), ['code_scout', 'doc_scout', 'reviewer'])
  })

  it('getProfileNames returns all 6 names', () => {
    const names = registry.getProfileNames().sort()
    assert.deepEqual(names, ['code_scout', 'doc_scout', 'patcher', 'planner', 'reviewer', 'verifier'])
  })

  it('rejects overriding built-in profiles', () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'patcher.md'), '---\nname: patcher\nrole: brain\ntools: ["read_file"]\n---\nOverride attempt')
      const result = registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('cannot override built-in'))
      // patcher should still be hands
      assert.equal(registry.get('patcher')!.role, 'hands')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('loads valid user-defined profile', () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'security-auditor.md'),
        '---\nname: security_auditor\nrole: readonly\ntools: ["read_file","grep","glob"]\n---\nYou audit code for security vulnerabilities.',
      )
      const result = registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['security_auditor'])
      assert.equal(result.errors.length, 0)
      const p = registry.get('security_auditor')!
      assert.equal(p.role, 'readonly')
      assert.equal(p.expertisePrompt, 'You audit code for security vulnerabilities.')
      assert.equal(p.builtIn, false)
      assert.deepEqual([...p.allowedTools], ['read_file', 'grep', 'glob'])
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for invalid frontmatter', () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'bad.md'), 'no frontmatter here')
      const result = registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('Missing YAML frontmatter'))
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for missing role', () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'no-role.md'), '---\nname: norole\ntools: ["read_file"]\n---\nMissing role')
      const result = registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('Invalid role'))
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('handles non-existent directory gracefully', () => {
    const result = registry.loadFromDirectory('/nonexistent/path/agents')
    assert.deepEqual(result.loaded, [])
    assert.deepEqual(result.errors, [])
  })
})
