/**
 * memory-learning hook — Wave 1（知识重构）契约测试。
 *
 * 核心契约：提取结果**只进内存缓冲，不落盘、不生成规则**。
 * 历史事故：正则直写曾产出互相矛盾的 auto-*.md 规则
 * （项目同时"用 jest/vitest/node:test/biome/eslint"）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMemoryLearningPostTurnHook, type ObservationCandidate } from '../hooks/memory-learning-hook.js'
import { maybeGenerateRule } from '../../memory/rule-generator.js'

describe('memory-learning hook — extract-only contract', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-memlearn-'))

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('delivers extracted candidates to buffer callback without touching disk', () => {
    const buffered: ObservationCandidate[] = []
    const hook = createMemoryLearningPostTurnHook({
      cwd,
      sessionId: 'test-session',
      getUserMessage: () => null,
      getStreamedText: () =>
        'This project uses node:test for unit testing across all modules and packages in the repository.',
      onObservationCandidates: candidates => buffered.push(...candidates),
    })

    hook.run({} as never)

    assert.ok(buffered.length >= 1, 'candidates must reach the buffer')
    assert.ok(buffered.some(c => c.text.includes('node:test')))
    // No .rivet artifacts may be created by extraction
    assert.equal(existsSync(join(cwd, '.rivet')), false, 'hook must not write to <cwd>/.rivet')
  })

  it('does not generate auto rules even after repeated observations', () => {
    const hook = createMemoryLearningPostTurnHook({
      cwd,
      getUserMessage: () => null,
      getStreamedText: () =>
        'This project uses vitest for testing. This project uses jest for testing too somehow.',
      onObservationCandidates: () => {},
    })

    for (let i = 0; i < 5; i++) hook.run({} as never)

    const rulesDir = join(cwd, '.rivet', 'rules')
    const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir) : []
    assert.equal(ruleFiles.length, 0, 'no auto-*.md rules may be generated')
  })

  it('skips short streamed text (< 80 chars)', () => {
    let called = false
    const hook = createMemoryLearningPostTurnHook({
      cwd,
      getUserMessage: () => null,
      getStreamedText: () => 'short text',
      onObservationCandidates: () => { called = true },
    })
    hook.run({} as never)
    assert.equal(called, false)
  })

  it('maybeGenerateRule is a hard no-op', () => {
    assert.equal(maybeGenerateRule(cwd, 'Project uses jest for testing'), null)
    assert.equal(existsSync(join(cwd, '.rivet', 'rules')), false)
  })
})
