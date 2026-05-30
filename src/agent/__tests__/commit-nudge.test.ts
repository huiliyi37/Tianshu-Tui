import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCommitNudge } from '../commit-nudge.js'

describe('buildCommitNudge', () => {
  it('returns empty string when file count is within threshold', () => {
    const nudge = buildCommitNudge({
      ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
    })
    assert.equal(nudge, '')
  })

  it('returns nudge when owned files exceed 4 across 2+ areas', () => {
    const nudge = buildCommitNudge({
      ownedFiles: [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts', 'src/tui/d.ts', 'src/config/e.ts',
      ],
    })
    assert.match(nudge, /deliver_task/)
    assert.match(nudge, /commit=true/)
  })

  it('returns nudge when owned files exceed 4 in same area', () => {
    const files = ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts', 'src/agent/d.ts', 'src/agent/e.ts']
    const nudge = buildCommitNudge({ ownedFiles: files })
    assert.match(nudge, /deliver_task/)
  })

  it('returns empty string for empty file list', () => {
    const nudge = buildCommitNudge({ ownedFiles: [] })
    assert.equal(nudge, '')
  })

  it('returns empty string when all files are in 1 area with ≤4 files', () => {
    const nudge = buildCommitNudge({
      ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts', 'src/agent/d.ts'],
    })
    assert.equal(nudge, '')
  })

  it('suggests files parameter when multiple areas detected', () => {
    const nudge = buildCommitNudge({
      ownedFiles: ['src/agent/a.ts', 'src/tools/b.ts', 'src/tui/c.ts', 'src/config/d.ts', 'src/api/e.ts'],
    })
    assert.match(nudge, /files=/)
  })
})
