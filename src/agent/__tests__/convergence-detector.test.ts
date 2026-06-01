import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateConvergence } from '../convergence-detector.js'
import type { ConvergenceInput, ConvergenceSignals, PhaseClass } from '../convergence-detector.js'

// ─── Helpers ────────────────────────────────────────────────────────

function makeHistory(
  entries: Array<{ tool: string; status?: 'success' | 'failed'; target?: string }>,
) {
  return entries.map(e => ({
    tool: e.tool,
    status: e.status ?? 'success',
    target: e.target ?? e.tool,
  }))
}

function emptyEvidence() {
  return {
    filesModified: new Set<string>(),
    filesRead: new Set<string>(),
    deliveryStatus: 'unverified' as const,
  }
}

function baseInput(overrides: Partial<ConvergenceInput>): ConvergenceInput {
  return {
    turn: 5,
    phaseClass: 'explore',
    contextWindow: 200_000,
    recentToolHistory: [],
    evidenceState: emptyEvidence(),
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('evaluateConvergence', () => {
  // ── Level 0: normal operation ──

  it('returns level 0 when turns below nLow', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'pattern' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 5,
      phaseClass: 'explore',
      recentToolHistory: history,
    }))
    assert.equal(result.level, 0)
    assert.equal(result.shouldAbort, false)
    assert.equal(result.injectedMessage, null)
  })

  it('returns level 0 when score is high (>0.6) even at mid turns', () => {
    // Diverse tools, successful edits, high novelty → high score
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'edit_file', target: 'c.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'grep', target: 'pattern' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 12,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // With edits and tests, score should be high
    assert.equal(result.level, 0, `expected level 0, got ${result.level} (score=${result.score.toFixed(2)})`)
  })

  // ── Level 1: immune nudge ──

  it('returns level 1 at nLow with low score in explore phase', () => {
    // All reads, no edits, repeating targets → low score in explore
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 8,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Repeating the same targets + same tools → low novelty + low entropy
    assert.ok(result.score <= 0.6, `expected score <= 0.6, got ${result.score.toFixed(2)}`)
    assert.equal(result.level, 1, `expected level 1, got ${result.level}`)
    assert.equal(result.shouldAbort, false)
    assert.equal(result.shouldKick, false)
    assert.equal(result.injectedMessage, null)
  })

  // ── Level 2: stuck warning + kick ──

  it('returns level 2 at nMid with low score in execute phase (no edits)', () => {
    // Execute phase with no edits for 8+ turns → should trigger
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'z' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // execute phase with 0 edits should score low
    assert.ok(result.score <= 0.4, `expected score <= 0.4, got ${result.score.toFixed(2)}`)
    assert.equal(result.level, 2, `expected level 2, got ${result.level} (score=${result.score.toFixed(2)})`)
    assert.equal(result.shouldKick, true)
    assert.ok(result.injectedMessage, 'expected injected message')
    assert.ok(result.injectedMessage!.includes('执行阶段'), 'message should mention execute phase')
  })

  it('returns level 2 with appropriate message in explore phase', () => {
    // Explore phase with extreme repetition: all read_file on the same file
    const history = makeHistory(
      Array.from({ length: 14 }, () => ({ tool: 'read_file', target: 'a.ts' })),
    )
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // All same tool + same target → targetNovelty=0.17, toolEntropy=0, tokenEfficiency=0
    // Score should be very low
    assert.ok(result.score <= 0.25, `expected score <= 0.25, got ${result.score.toFixed(2)}`)
    assert.equal(result.level, 2, `expected level 2, got ${result.level} (score=${result.score.toFixed(2)})`)
    assert.ok(result.injectedMessage!.includes('工具使用模式高度重复'), 'should mention tool repetition')
  })

  // ── Level 3: force split or abort ──

  it('returns level 3 at nHigh with very low score', () => {
    // All repeats, no diversity, many turns
    const history = makeHistory([
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 20,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    assert.equal(result.level, 3, `expected level 3, got ${result.level} (score=${result.score.toFixed(2)})`)
    assert.equal(result.shouldForceSplit, true)
    assert.ok(result.injectedMessage, 'should have injected message')
  })

  it('returns shouldAbort true when score is extremely low at level 3', () => {
    const history = makeHistory([
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 25,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    assert.equal(result.level, 3)
    // All failures + all same tool → score should be extremely low
    assert.ok(result.score < 0.1, `expected score < 0.1, got ${result.score.toFixed(2)}`)
    assert.equal(result.shouldAbort, true)
  })

  // ── 200K vs 1M thresholds ──

  it('1M window has higher nLow threshold', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
    ])
    // At turn 10, 200K would trigger level 1 or 2, but 1M should stay at 0
    const result1M = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 1_000_000,
      recentToolHistory: history,
    }))
    const result200K = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // 1M should be more lenient: lower level or same score but higher threshold
    assert.ok(
      result1M.level <= result200K.level,
      `1M level=${result1M.level} should be <= 200K level=${result200K.level}`,
    )
  })

  it('1M uses larger signal window', () => {
    // With a larger signal window (10 vs 6), the same history produces
    // slightly different scores. Verify both produce valid scores.
    const history = makeHistory(
      Array.from({ length: 12 }, (_, i) => ({
        tool: i % 3 === 0 ? 'grep' : 'read_file',
        target: `file${i % 4}.ts`,
      })),
    )
    const result1M = evaluateConvergence(baseInput({
      turn: 18,
      phaseClass: 'explore',
      contextWindow: 1_000_000,
      recentToolHistory: history,
    }))
    const result200K = evaluateConvergence(baseInput({
      turn: 18,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    assert.ok(result1M.score >= 0 && result1M.score <= 1, '1M score in range')
    assert.ok(result200K.score >= 0 && result200K.score <= 1, '200K score in range')
  })

  // ── Phase-aware behavior ──

  it('execute phase is stricter on edit ratio', () => {
    // Same history, different phases — execute should score lower
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'read_file', target: 'd.ts' },
    ])
    const exploreResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    const executeResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // execute phase weights editRatio higher → score should be lower without edits
    assert.ok(
      executeResult.score <= exploreResult.score,
      `execute score=${executeResult.score.toFixed(2)} should be <= explore score=${exploreResult.score.toFixed(2)}`,
    )
  })

  it('explore phase tolerates high novelty and diversity', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'glob', target: '*.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'repo_map', target: '' },
      { tool: 'grep', target: 'y' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 8,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Diverse tools + diverse targets in explore should yield reasonable score
    assert.ok(result.score >= 0.3, `expected score >= 0.3, got ${result.score.toFixed(2)}`)
    // Should not trigger level 2 in explore just for being diverse
    assert.ok(result.level <= 1, `expected level <= 1, got ${result.level}`)
  })

  // ── Error rate impact ──

  it('high error rate drags score down', () => {
    const failingHistory = makeHistory([
      { tool: 'bash', target: 'cmd', status: 'failed' },
      { tool: 'bash', target: 'cmd', status: 'failed' },
      { tool: 'bash', target: 'cmd', status: 'failed' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const successHistory = makeHistory([
      { tool: 'bash', target: 'cmd1' },
      { tool: 'bash', target: 'cmd2' },
      { tool: 'bash', target: 'cmd3' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'read_file', target: 'c.ts' },
    ])
    const failResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: failingHistory,
    }))
    const successResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: successHistory,
    }))
    assert.ok(
      failResult.score < successResult.score,
      `fail score=${failResult.score.toFixed(2)} should be < success score=${successResult.score.toFixed(2)}`,
    )
  })

  // ── Signal structure ──

  it('signals are within valid range', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'edit_file', target: 'b.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 6,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    const s: ConvergenceSignals = result.signals
    assert.ok(s.editRatio >= 0 && s.editRatio <= 1, `editRatio ${s.editRatio} out of range`)
    assert.ok(s.targetNovelty >= 0 && s.targetNovelty <= 1, `targetNovelty ${s.targetNovelty} out of range`)
    assert.ok(s.toolEntropy >= 0 && s.toolEntropy <= 1, `toolEntropy ${s.toolEntropy} out of range`)
    assert.ok(s.errorPenalty >= 0 && s.errorPenalty <= 1, `errorPenalty ${s.errorPenalty} out of range`)
    assert.ok(s.tokenEfficiency >= 0 && s.tokenEfficiency <= 1, `tokenEfficiency ${s.tokenEfficiency} out of range`)
  })

  // ── Edge cases ──

  it('handles empty history gracefully', () => {
    const result = evaluateConvergence(baseInput({
      turn: 0,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: [],
    }))
    assert.equal(result.level, 0)
    assert.equal(result.shouldAbort, false)
    assert.ok(result.score >= 0 && result.score <= 1)
  })

  it('handles intermediate window sizes via interpolation', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'explore',
      contextWindow: 500_000, // intermediate between 200K and 1M
      recentToolHistory: history,
    }))
    // Should compute valid result for intermediate window
    assert.ok(result.score >= 0 && result.score <= 1)
    assert.ok([0, 1, 2, 3].includes(result.level))
  })

  it('deliver phase is strict', () => {
    // deliver phase weights editRatio high, so no edits → low score
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'read_file', target: 'd.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 20,
      phaseClass: 'deliver',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Zero edits in deliver → low editRatio component → low overall score
    assert.ok(result.score < 0.5, `expected score < 0.5 in deliver with no edits, got ${result.score.toFixed(2)}`)
    assert.ok(result.level >= 2, `expected level >= 2 in deliver, got ${result.level}`)
  })
})
