import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSplit, type SplitInput } from '../split-policy.js'

describe('split-policy', () => {
  it('recommends split when task touches 3+ independent modules', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/tui/app.tsx', 'src/agent/loop.ts'],
      estimatedTurns: 10,
      hasTests: true,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, true)
    assert.equal(result.workers.length, 3)
  })

  it('does not split for single-module task', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/api/types.ts'],
      estimatedTurns: 3,
      hasTests: true,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, false)
  })

  it('does not split for short tasks regardless of modules', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/tui/app.tsx', 'src/agent/loop.ts'],
      estimatedTurns: 2,
      hasTests: false,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, false)
  })

  it('groups files by module correctly', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/api/types.ts', 'src/tui/app.tsx', 'src/tui/render.tsx', 'src/agent/loop.ts'],
      estimatedTurns: 15,
      hasTests: true,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, true)
    assert.equal(result.workers.length, 3)
    const apiWorker = result.workers.find((w: { module: string }) => w.module === 'api')
    assert.ok(apiWorker)
    assert.equal(apiWorker.files.length, 2)
  })
})
