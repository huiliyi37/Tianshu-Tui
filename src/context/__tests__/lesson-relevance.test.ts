import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreLessons } from '../lesson-relevance.js'
import type { PlaybookBullet } from '../../agent/playbook.js'

function makeBullet(overrides: Partial<PlaybookBullet> & { id: string }): PlaybookBullet {
  return {
    createdAt: Date.now(),
    keywords: [],
    lesson: '',
    context: 'root-cause',
    useCount: 0,
    lastUsedAt: null,
    importance: 0.6,
    ...overrides,
  }
}

describe('lesson-relevance', () => {
  it('returns empty selected for empty playbook', () => {
    const result = scoreLessons([], { query: 'typescript error' })
    assert.deepEqual(result.selected, [])
    assert.deepEqual(result.scored, [])
    assert.deepEqual(result.omitted, [])
  })

  it('ranks lessons with keyword hits higher', () => {
    const matching = makeBullet({
      id: 'matching',
      keywords: ['typescript', 'error'],
      lesson: 'Always check type assertions',
      importance: 0.5,
    })
    const unrelated = makeBullet({
      id: 'unrelated',
      keywords: ['docker', 'container'],
      lesson: 'Use multi-stage builds for Docker',
      importance: 0.5,
    })
    const result = scoreLessons([matching, unrelated], { query: 'typescript error' })

    assert.equal(result.selected[0]?.id, 'matching')
    assert.ok(result.scored[0]!.score > result.scored[1]!.score)
  })

  it('filters out lessons below minScore', () => {
    const lowScore = makeBullet({
      id: 'low',
      keywords: ['docker'],
      lesson: 'Docker tip',
      importance: 0.1,
    })
    const result = scoreLessons([lowScore], { query: 'typescript error' })
    // docker doesn't match typescript or error → score = importance * 20 = 2
    assert.equal(result.selected.length, 0)
    assert.ok(result.omitted.length > 0)
  })

  it('penalizes dead-end lessons without matching failure patterns', () => {
    const deadEnd = makeBullet({
      id: 'dead-end',
      keywords: ['dead-end', 'retry'],
      lesson: 'This is a dead-end approach, do not retry blindly',
      importance: 0.7,
    })
    const result = scoreLessons([deadEnd], { query: 'retry', recentFailurePatterns: [] })

    const scored = result.scored.find(s => s.bullet.id === 'dead-end')!
    assert.ok(scored)
    // Should have -40 penalty: importance(14) + keyword(15) + lesson(20) - 40 = 9
    assert.ok(scored.score < 20, `Expected heavy penalty, got ${scored.score}`)
    assert.ok(scored.reasons.some(r => r.includes('dead-end without matching failure')))
  })

  it('does not penalize dead-end lessons with matching failure patterns', () => {
    const deadEnd = makeBullet({
      id: 'dead-end-matched',
      keywords: ['dead-end', 'bash'],
      lesson: 'This is a dead-end bash approach',
      importance: 0.7,
    })
    const result = scoreLessons([deadEnd], {
      query: 'bash',
      recentFailurePatterns: ['bash'],
    })

    const scored = result.scored.find(s => s.bullet.id === 'dead-end-matched')!
    assert.ok(scored)
    // Should NOT have -40 penalty because 'bash' failure pattern matches
    assert.ok(!scored.reasons.some(r => r.includes('dead-end without matching failure')))
    assert.ok(scored.score > 0)
    // Should be selected since it scores well
    assert.ok(result.selected.some(b => b.id === 'dead-end-matched'))
  })

  it('respects maxLessons=2 with 3 relevant lessons', () => {
    const b1 = makeBullet({ id: 'a', keywords: ['typescript'], lesson: 'TS tip', importance: 0.9 })
    const b2 = makeBullet({ id: 'b', keywords: ['typescript'], lesson: 'TS tip 2', importance: 0.8 })
    const b3 = makeBullet({ id: 'c', keywords: ['typescript'], lesson: 'TS tip 3', importance: 0.7 })

    const result = scoreLessons([b1, b2, b3], { query: 'typescript', maxLessons: 2 })
    assert.equal(result.selected.length, 2)
    assert.equal(result.omitted.length, 1)
    // The omitted one should be the lowest scoring (b3 with lower importance)
    assert.equal(result.omitted[0]?.bullet.id, 'c')
  })

  it('gives higher importance lessons more points', () => {
    const highImportance = makeBullet({
      id: 'high',
      keywords: ['test'],
      lesson: 'Test lesson',
      importance: 1.0,
    })
    const lowImportance = makeBullet({
      id: 'low',
      keywords: ['test'],
      lesson: 'Test lesson 2',
      importance: 0.2,
    })

    const result = scoreLessons([highImportance, lowImportance], { query: 'test' })
    const highScored = result.scored.find(s => s.bullet.id === 'high')!
    const lowScored = result.scored.find(s => s.bullet.id === 'low')!

    // Both have keyword match + lesson text match, but different importance
    // high: 15 (keyword) + 20 (lesson) + 20 (importance * 20) = 55
    // low:  15 (keyword) + 20 (lesson) + 4 (importance * 20) = 39
    assert.ok(highScored.score > lowScored.score)
    assert.equal(result.selected[0]?.id, 'high')
  })

  it('adds bonus for recentToolTargets match', () => {
    const withTool = makeBullet({
      id: 'tool-match',
      keywords: ['bash', 'shell'],
      lesson: 'Use shell carefully',
      importance: 0.5,
    })
    const noTool = makeBullet({
      id: 'no-tool',
      keywords: ['typescript'],
      lesson: 'Use typescript carefully',
      importance: 0.5,
    })

    const result = scoreLessons([withTool, noTool], {
      query: 'carefully',
      recentToolTargets: ['bash'],
    })

    const toolScored = result.scored.find(s => s.bullet.id === 'tool-match')!
    const noToolScored = result.scored.find(s => s.bullet.id === 'no-tool')!

    assert.ok(toolScored.score > noToolScored.score)
    assert.ok(toolScored.reasons.some(r => r.includes('tool target match')))
  })

  it('correctly stacks multiple scoring factors', () => {
    const bullet = makeBullet({
      id: 'multi',
      keywords: ['typescript', 'error', 'bash'],
      lesson: 'Fix typescript error in bash script',
      context: 'root-cause typescript error',
      importance: 0.8,
    })

    const result = scoreLessons([bullet], {
      query: 'typescript error',
      recentToolTargets: ['bash'],
      recentFailurePatterns: ['error'],
    })

    const scored = result.scored[0]!
    // Expected:
    // keyword match: 15 * 2 (typescript, error both match) = 30
    // lesson text match: +20 (typescript in lesson)
    // failure context match: +25 (error matches)
    // tool target match: +15 * 1 (bash matches) = 15
    // importance: round(0.8 * 20) = 16
    // Total: 30 + 20 + 25 + 15 + 16 = 106
    assert.equal(scored.score, 106)
    assert.equal(scored.reasons.length, 5)
    assert.ok(result.selected.includes(bullet))
  })
})
