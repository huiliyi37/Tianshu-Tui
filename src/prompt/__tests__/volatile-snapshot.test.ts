import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVolatileSnapshot } from '../volatile-snapshot.js'

describe('createVolatileSnapshot', () => {
  it('captures gitStatus at creation time and freezes it', () => {
    let currentGit = 'M src/foo.ts'
    const getGit = () => currentGit

    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: getGit,
    })

    assert.equal(snapshot.gitStatus, 'M src/foo.ts')

    // Simulate git status changing after snapshot
    currentGit = 'M src/foo.ts\nM src/bar.ts'
    assert.equal(snapshot.gitStatus, 'M src/foo.ts', 'snapshot should not change')
  })

  it('returns frozen object (immutable)', () => {
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: () => 'clean',
    })

    assert.throws(() => {
      ;(snapshot as any).cwd = '/changed'
    }, TypeError)
  })

  it('handles undefined git status gracefully', () => {
    const snapshot = createVolatileSnapshot({ cwd: '/nonexistent' })
    assert.equal(snapshot.gitStatus, undefined)
  })

  it('copies workingSet array to prevent external mutation', () => {
    const files = ['src/a.ts']
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: () => undefined,
      workingSet: files,
    })

    files.push('src/b.ts')
    assert.deepEqual(snapshot.workingSet, ['src/a.ts'], 'snapshot workingSet should not be affected by external mutation')
  })

  it('freezes workingSet array contents', () => {
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      getGitStatus: () => undefined,
      workingSet: ['src/a.ts'],
    })

    assert.throws(() => {
      ;(snapshot.workingSet as any).push('src/b.ts')
    }, TypeError)
  })

  it('preserves activeDomain when provided', () => {
    const domain = { name: 'test', volatileBlock: 'block', motto: 'motto' }
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      activeDomain: domain,
    })

    assert.deepEqual(snapshot.activeDomain, domain)
  })

  it('sets activeDomain to undefined when not provided', () => {
    const snapshot = createVolatileSnapshot({ cwd: '/test' })
    assert.equal(snapshot.activeDomain, undefined)
  })

  it('preserves sessionMemoryBlock', () => {
    const snapshot = createVolatileSnapshot({
      cwd: '/test',
      sessionMemoryBlock: 'remember this',
    })
    assert.equal(snapshot.sessionMemoryBlock, 'remember this')
  })

  it('does not snapshot project knowledge files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'volatile-snapshot-knowledge-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(join(knowledgeDir, 'project-memory.md'), '### Memory\nDo not inject me.\n', 'utf-8')

      const snapshot = createVolatileSnapshot({ cwd })

      assert.equal('_knowledgeSnapshot' in snapshot, false)
      assert.equal(JSON.stringify(snapshot).includes('Do not inject me'), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
