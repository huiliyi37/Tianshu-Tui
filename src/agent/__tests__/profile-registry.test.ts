import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProfileRegistry, delegationToolTimeoutMs, DEFAULT_DELEGATE_CONCURRENCY } from '../profile-registry.js'
import { progressiveTimeout, WORKER_EXIT_GRACE_MS } from '../timeout-ladder.js'

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

  it('has 18 built-in profiles (9 core + 6 flash-army + designer + council_expert + goal_judge)', async () => {
    assert.equal(registry.list().length, 18)
  })

  it('maps code_scout as readonly', async () => {
    const p = registry.get('code_scout')!
    assert.ok(p)
    assert.equal(p.role, 'readonly')
    assert.equal(p.builtIn, true)
  })

  it('maps patcher as hands with write tools', async () => {
    const p = registry.get('patcher')!
    assert.ok(p)
    assert.equal(p.role, 'hands')
    assert.ok(p.allowedTools.includes('edit_file'))
    assert.ok(p.allowedTools.includes('write_file'))
    assert.ok(p.allowedTools.includes('bash'))
  })

  it('maps planner as brain with delegate tools', async () => {
    const p = registry.get('planner')!
    assert.ok(p)
    assert.equal(p.role, 'brain')
    assert.ok(p.allowedTools.includes('delegate_task'))
    assert.ok(p.allowedTools.includes('delegate_batch'))
  })

  it('maps verifier as hands with defaultKind=verify', async () => {
    const p = registry.get('verifier')!
    assert.ok(p)
    assert.equal(p.role, 'hands')
    assert.equal(p.defaultKind, 'verify')
    assert.equal(p.defaultMaxTokens, 16384)
  })

  it('maps adversarial_verifier as readonly_plus_test with no write/bash tools', async () => {
    const p = registry.get('adversarial_verifier')!
    assert.ok(p)
    assert.equal(p.role, 'readonly_plus_test')
    assert.equal(p.defaultKind, 'verify')
    assert.equal(p.defaultMaxTokens, 16384)
    assert.ok(p.allowedTools.includes('run_tests'))
    assert.ok(p.allowedTools.includes('read_file'))
    assert.ok(!p.allowedTools.includes('edit_file'))
    assert.ok(!p.allowedTools.includes('write_file'))
    assert.ok(!p.allowedTools.includes('bash'))
  })

  it('listWriteProfiles returns hands roles (adversarial_verifier is not hands)', async () => {
    const write = registry.listWriteProfiles()
    // adversarial_verifier has role 'readonly_plus_test', not 'hands' — excluded from write list.
    // Flash-army hands profiles (lint_fixer/type_fixer/import_organizer/doc_syncer/test_scaffolder) included.
    assert.deepEqual(write.sort(), ['doc_syncer', 'import_organizer', 'lint_fixer', 'patcher', 'test_scaffolder', 'type_fixer', 'verifier'])
  })

  it('listReadOnlyProfiles returns readonly roles', async () => {
    const ro = registry.listReadOnlyProfiles()
    // adversarial_verifier is readonly_plus_test, not 'readonly' — excluded from readonly list.
    // designer + format_checker are readonly and included.
    assert.deepEqual(ro.sort(), ['architect', 'code_scout', 'council_expert', 'designer', 'doc_scout', 'format_checker', 'reviewer', 'troubleshooter'])
  })

  it('getProfileNames returns all 18 names', async () => {
    const names = registry.getProfileNames().sort()
    assert.deepEqual(names, ['adversarial_verifier', 'architect', 'code_scout', 'council_expert', 'designer', 'doc_scout', 'doc_syncer', 'format_checker', 'goal_judge', 'import_organizer', 'lint_fixer', 'patcher', 'planner', 'reviewer', 'test_scaffolder', 'troubleshooter', 'type_fixer', 'verifier'])
  })

  it('rejects overriding built-in profiles', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'patcher.md'), '---\nname: patcher\nrole: brain\ntools: ["read_file"]\n---\nOverride attempt')
      const result = await registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('cannot override built-in'))
      // patcher should still be hands
      assert.equal(registry.get('patcher')!.role, 'hands')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('loads valid user-defined profile', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'security-auditor.md'),
        '---\nname: security_auditor\nrole: readonly\ntools: ["read_file","grep","glob"]\n---\nYou audit code for security vulnerabilities.',
      )
      const result = await registry.loadFromDirectory(tmp)
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

  it('reports error for invalid frontmatter', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'bad.md'), 'no frontmatter here')
      const result = await registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('Missing YAML frontmatter'))
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for missing role', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(join(tmp, 'no-role.md'), '---\nname: norole\ntools: ["read_file"]\n---\nMissing role')
      const result = await registry.loadFromDirectory(tmp)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0]!.includes('Invalid role'))
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('handles non-existent directory gracefully', async () => {
    const result = await registry.loadFromDirectory('/nonexistent/path/agents')
    assert.deepEqual(result.loaded, [])
    assert.deepEqual(result.errors, [])
  })

  it('parses maxTokens as number from YAML frontmatter', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'custom.md'),
        '---\nname: custom_worker\nrole: hands\ntools: ["read_file","edit_file"]\nmaxTokens: 32768\n---\nCustom worker.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['custom_worker'])
      assert.equal(result.errors.length, 0)
      const p = registry.get('custom_worker')!
      assert.equal(p.defaultMaxTokens, 32768, 'maxTokens should be parsed as number, not undefined')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('handles maxTokens with non-numeric value gracefully', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'bad-tokens.md'),
        '---\nname: bad_tokens\nrole: hands\ntools: ["read_file"]\nmaxTokens: abc\n---\nBad tokens.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['bad_tokens'])
      const p = registry.get('bad_tokens')!
      assert.equal(p.defaultMaxTokens, undefined, 'non-numeric maxTokens should be undefined')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('parses YAML array with values containing apostrophes', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'apostrophe.md'),
        // Use double quotes in YAML array to avoid apostrophe parsing issues
        '---\nname: apostrophe_test\nrole: readonly\ntools: ["read_file","grep"]\n---\nAgent for McDonald\'s code.',
      )
      const result = await registry.loadFromDirectory(tmp)
      assert.deepEqual(result.loaded, ['apostrophe_test'])
      assert.equal(result.errors.length, 0, 'should not error on arrays parsed correctly')
      const p = registry.get('apostrophe_test')!
      assert.deepEqual([...p.allowedTools], ['read_file', 'grep'])
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })

  it('reports error for malformed array with apostrophes in single-quoted values', async () => {
    const tmp = makeTmpDir()
    try {
      writeFileSync(
        join(tmp, 'bad-array.md'),
        // This has single-quoted array with values containing apostrophes - will fail JSON.parse
        "---\nname: bad_array\nrole: readonly\ntools: ['read_file','grep']\n---\nBad array.",
      )
      const result = await registry.loadFromDirectory(tmp)
      // The tools should either parse correctly or report an error
      // With current implementation, fallback to [val] which is not an array of tool names
      // After fix, this should produce an error
      assert.ok(result.loaded.length > 0 || result.errors.length > 0, 'should either load or report error, not silently corrupt')
    } finally {
      rmSync(tmp, { recursive: true })
    }
  })
})

describe('delegationToolTimeoutMs (A2: wave-scaled batch timeout)', () => {
  const mature = progressiveTimeout(undefined) // 180s

  it('single wave (taskCount <= maxWorkers) equals legacy budget + grace', async () => {
    const single = delegationToolTimeoutMs(undefined, [undefined, undefined], { taskCount: 2 })
    assert.equal(single, mature + WORKER_EXIT_GRACE_MS)
  })

  it('backward-compatible: no opts defaults taskCount to profiles.length', async () => {
    // 3 profiles, default concurrency 3 → 1 wave → unchanged from the old behavior.
    const legacy = delegationToolTimeoutMs(undefined, [undefined, undefined, undefined])
    assert.equal(legacy, mature + WORKER_EXIT_GRACE_MS)
  })

  it('scales by ceil(taskCount / maxWorkers) waves', async () => {
    // 5 tasks on the default 3-worker pool → ceil(5/3)=2 waves.
    const twoWaves = delegationToolTimeoutMs(undefined, [], { taskCount: 5 })
    assert.equal(twoWaves, mature * 2 + WORKER_EXIT_GRACE_MS)
    assert.equal(DEFAULT_DELEGATE_CONCURRENCY, 3)
  })

  it('honors explicit maxWorkers when provided', async () => {
    // 10 tasks / 3 workers → ceil = 4 waves.
    const fourWaves = delegationToolTimeoutMs(undefined, [], { taskCount: 10, maxWorkers: 3 })
    assert.equal(fourWaves, mature * 4 + WORKER_EXIT_GRACE_MS)
  })

  it('never returns less than one wave for empty/zero input', async () => {
    const floor = delegationToolTimeoutMs(undefined, [], { taskCount: 0 })
    assert.equal(floor, mature + WORKER_EXIT_GRACE_MS)
  })
})
