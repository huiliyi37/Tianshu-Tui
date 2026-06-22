import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectExplorationStall, EXPLORATION_TOOLS } from '../exploration-stall.js'

function traj(tools: string[]) {
  return tools.map(tool => ({ tool, target: '', status: 'success' }))
}

describe('detectExplorationStall', () => {
  it('blocks after threshold consecutive exploration tools', () => {
    const history = traj(['grep', 'read_file', 'grep', 'glob', 'read_file', 'grep', 'read_file'])
    // 7 in history + 1 current = 8 → blocked at explicit threshold=8
    const result = detectExplorationStall(history, 'grep', 8)
    assert.equal(result.blocked, true)
    assert.equal(result.consecutiveExploreCount, 8)
    assert.match(result.message!, /Exploration stall/)
    assert.equal(result.advisory, null)
  })

  it('does NOT block below threshold', () => {
    const history = traj(['grep', 'read_file', 'grep'])
    const result = detectExplorationStall(history, 'read_file')
    assert.equal(result.blocked, false)
    assert.equal(result.consecutiveExploreCount, 4)
    assert.equal(result.advisory, null)
  })

  it('resets count when an action tool appears in history', () => {
    // edit_file breaks the streak — only 2 exploration tools after it
    const history = traj(['grep', 'grep', 'grep', 'edit_file', 'grep', 'read_file'])
    const result = detectExplorationStall(history, 'grep')
    assert.equal(result.blocked, false)
    assert.equal(result.consecutiveExploreCount, 3)
    assert.equal(result.advisory, null)
  })

  it('only gates exploration tools — action tools pass through', () => {
    const history = traj(['grep', 'grep', 'grep', 'grep', 'grep', 'grep', 'grep', 'grep'])
    const result = detectExplorationStall(history, 'edit_file')
    assert.equal(result.blocked, false)
  })

  it('respects custom threshold', () => {
    const history = traj(['grep', 'read_file'])
    const result = detectExplorationStall(history, 'grep', 3)
    assert.equal(result.blocked, true)
    assert.equal(result.consecutiveExploreCount, 3)
  })

  it('counts bash as action tool (breaks exploration streak)', () => {
    const history = traj(['grep', 'grep', 'bash', 'grep', 'read_file'])
    const result = detectExplorationStall(history, 'grep')
    assert.equal(result.blocked, false)
    assert.equal(result.consecutiveExploreCount, 3)
  })

  it('handles empty trajectory', () => {
    const result = detectExplorationStall([], 'grep')
    assert.equal(result.blocked, false)
    assert.equal(result.consecutiveExploreCount, 1)
  })

  it('returns soft advisory (not blocked) at 12-14 consecutive', () => {
    // 11 in history + 1 current = 12 → advisory, not blocked
    const history = traj(Array.from({ length: 11 }, () => 'read_file'))
    const result = detectExplorationStall(history, 'read_file')
    assert.equal(result.blocked, false, 'should not hard-block at advisory level')
    assert.equal(result.consecutiveExploreCount, 12)
    assert.ok(result.advisory !== null, 'should have advisory message')
    assert.ok(result.advisory!.includes('exploration'))
  })

  it('hard-blocks at 15+ consecutive', () => {
    const history = traj(Array.from({ length: 14 }, () => 'read_file'))
    const result = detectExplorationStall(history, 'read_file')
    assert.equal(result.blocked, true, 'should hard-block at 15+')
    assert.equal(result.consecutiveExploreCount, 15)
    assert.equal(result.advisory, null)
  })

  it('disables advisory when explicit small threshold is passed', () => {
    // Caller passes threshold=5 → strict blocking mode, no advisory zone
    const history = traj(Array.from({ length: 11 }, () => 'read_file'))
    const result = detectExplorationStall(history, 'read_file', 5)
    assert.equal(result.blocked, true, 'small threshold should hard-block')
    assert.equal(result.advisory, null, 'advisory should be disabled with explicit small threshold')
  })

  it('does not trigger advisory before threshold 12', () => {
    const history = traj(Array.from({ length: 10 }, () => 'read_file'))
    const result = detectExplorationStall(history, 'read_file')
    assert.equal(result.blocked, false)
    assert.equal(result.consecutiveExploreCount, 11)
    assert.equal(result.advisory, null)
  })

  it('EXPLORATION_TOOLS includes expected set', () => {
    assert.ok(EXPLORATION_TOOLS.has('grep'))
    assert.ok(EXPLORATION_TOOLS.has('read_file'))
    assert.ok(EXPLORATION_TOOLS.has('glob'))
    assert.ok(EXPLORATION_TOOLS.has('semantic_search'))
    assert.ok(!EXPLORATION_TOOLS.has('edit_file'))
    assert.ok(!EXPLORATION_TOOLS.has('bash'))
  })
})
