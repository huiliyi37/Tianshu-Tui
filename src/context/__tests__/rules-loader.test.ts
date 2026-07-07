import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectRules } from '../rules-loader.js'

describe('loadProjectRules', () => {
  it('loads .md files from rules directory as project_rule proposals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'no-force-push.md'), 'Never use git push --force on main branch.')
    writeFileSync(join(rulesDir, 'test-first.md'), 'Always run tests before committing.')

    try {
      const proposals = loadProjectRules(dir)

      assert.equal(proposals.length, 2)
      assert.ok(proposals.every(p => p.kind === 'project_rule'))
      assert.ok(proposals.every(p => p.scope === 'project'))
      assert.ok(proposals.every(p => p.confidence === 1.0))
      assert.ok(proposals.some(p => p.text.includes('Never use git push --force')))
      assert.ok(proposals.some(p => p.text.includes('Always run tests')))
      assert.ok(proposals.every(p => p.tags.includes('project_rule')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty array when rules directory does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-norules-'))
    try {
      const proposals = loadProjectRules(dir)
      assert.deepEqual(proposals, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips non-md files and empty files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'valid.md'), 'Use TypeScript strict mode.')
    writeFileSync(join(rulesDir, 'readme.txt'), 'This is not a rule.')
    writeFileSync(join(rulesDir, 'empty.md'), '')

    try {
      const proposals = loadProjectRules(dir)
      assert.equal(proposals.length, 1)
      assert.ok(proposals[0]!.text.includes('TypeScript strict mode'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('truncates long rule files to 500 chars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
    const rulesDir = join(dir, '.rivet', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'long.md'), 'x'.repeat(1000))

    try {
      const proposals = loadProjectRules(dir)
      assert.ok(proposals[0]!.text.length <= 500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
