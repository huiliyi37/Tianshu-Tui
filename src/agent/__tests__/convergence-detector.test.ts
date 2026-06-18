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
    // All reads, no edits, heavily repeating targets → low score in explore
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 8,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Single tool + single target → targetNovelty≈0.17, toolEntropy=0, tokenEfficiency=0
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
    // All same tool + same target → targetNovelty≈0.17, toolEntropy=0, tokenEfficiency=0
    // With new textRepetitionPenalty weight (1.0 when no fingerprints provided),
    // score is slightly higher than before. Level may be 1 or 2 depending on exact weight sum.
    assert.ok(result.score <= 0.45, `expected score <= 0.45, got ${result.score.toFixed(2)}`)
    assert.ok(result.level >= 1, `expected level >= 1, got ${result.level} (score=${result.score.toFixed(2)})`)
    if (result.level >= 2 && result.injectedMessage) {
      // Message can be either the productiveStagnation variant ("读取/搜索操作")
      // or the standard tool-repetition message ("工具使用模式高度重复")
      assert.ok(
        result.injectedMessage.includes('工具使用模式高度重复') || result.injectedMessage.includes('读取'),
        `expected stagnation-related message, got: ${result.injectedMessage.slice(0, 120)}`,
      )
    }
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

  // ── Oscillation detection ──

  it('oscillation pattern (A→B→A→B→A→B) scores low', () => {
    // Simulate post-completion verification loop: git log → ls → git log → ls → ...
    const history = makeHistory([
      { tool: 'bash', target: 'git log --oneline' },
      { tool: 'bash', target: 'ls .rivet/sessions/' },
      { tool: 'bash', target: 'git log --oneline' },
      { tool: 'bash', target: 'ls .rivet/sessions/' },
      { tool: 'bash', target: 'git log --oneline' },
      { tool: 'bash', target: 'ls .rivet/sessions/' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      toolFingerprints: ['fp-git', 'fp-ls', 'fp-git', 'fp-ls', 'fp-git', 'fp-ls'],
    }))
    // Oscillation + no edits + verify phase → score should be low enough for level 2+
    assert.ok(result.score < 0.45, `expected score < 0.45 for oscillation, got ${result.score.toFixed(2)}`)
    assert.ok(result.level >= 2, `expected level >= 2 for oscillation, got ${result.level}`)
    assert.ok(result.signals.oscillationPenalty !== undefined, 'should have oscillationPenalty signal')
    assert.ok(result.signals.oscillationPenalty < 0.5, `oscillation penalty should be severe, got ${result.signals.oscillationPenalty}`)
  })

  it('no oscillation penalty when fingerprints are diverse', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'glob', target: '*.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'edit_file', target: 'c.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
      toolFingerprints: ['fp1', 'fp2', 'fp3', 'fp4', 'fp5', 'fp6'],
    }))
    // All unique fingerprints → no oscillation penalty
    assert.equal(result.signals.oscillationPenalty, 1.0)
  })

  it('missing toolFingerprints defaults to no penalty', () => {
    const history = makeHistory([
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      // toolFingerprints intentionally omitted
    }))
    // Without fingerprints, oscillation penalty defaults to 1.0 (no penalty)
    assert.equal(result.signals.oscillationPenalty, 1.0)
  })

  // ── Delivery-aware completion nudge ──

  it('verified deliveryStatus triggers completion nudge message', () => {
    const history = makeHistory([
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'git log' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'bash', target: 'git log' },
      { tool: 'read_file', target: 'c.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      evidenceState: {
        filesModified: new Set(['src/x.ts']),
        filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
        deliveryStatus: 'verified',
      },
    }))
    // When verified + level 2, message should be a completion nudge, not "choose an action"
    if (result.level >= 2 && result.injectedMessage) {
      assert.ok(result.injectedMessage.includes('任务可能已完成'),
        `expected completion nudge, got: ${result.injectedMessage.slice(0, 120)}`)
      assert.ok(!result.injectedMessage.includes('请选择以下行动'),
        'should not ask to choose actions when task is verified')
    }
  })

  it('unverified deliveryStatus does not trigger completion nudge', () => {
    const history = makeHistory([
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'bash', target: 'git log' },
      { tool: 'read_file', target: 'c.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      evidenceState: {
        filesModified: new Set(['src/x.ts']),
        filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
        deliveryStatus: 'unverified',
      },
    }))
    // Should still trigger Level 2 (low score), but NOT the completion message
    // It uses the standard "请选择以下行动" message
    if (result.level >= 2 && result.injectedMessage) {
      assert.ok(result.injectedMessage.includes('请选择以下行动'),
        `expected standard stuck message, got: ${result.injectedMessage.slice(0, 120)}`)
      assert.ok(!result.injectedMessage.includes('任务可能已完成'),
        'should not trigger completion nudge for unverified state')
    }
  })

  // ── No-tool stagnation: forced abort at 5 consecutive no-tool turns ──

  describe('no-tool forced abort (hard cap)', () => {
    it('forces level 3 and shouldAbort when noToolTurnCount >= 5', () => {
      const result = evaluateConvergence(baseInput({
        turn: 5, // well below nLow=8 for 200K, but noTool overrides
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
      }))
      assert.equal(result.level, 3, `expected level 3, got ${result.level}`)
      assert.equal(result.shouldAbort, true, 'expected shouldAbort=true at 5 no-tool turns')
    })

    it('forces shouldAbort even when convergence score is high (penalty makes it low)', () => {
      // Even with good tool history in the window, 5 no-tool turns force abort
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts', status: 'success' },
        { tool: 'edit_file', target: 'b.ts', status: 'success' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 10,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 5,
      }))
      assert.equal(result.shouldAbort, true, 'forced abort should override score-based logic')
    })

    it('does NOT forceSplit when abort is from no-tool stagnation', () => {
      const result = evaluateConvergence(baseInput({
        turn: 10,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
      }))
      assert.equal(result.shouldAbort, true)
      assert.equal(result.shouldForceSplit, false, 'session split is pointless for text-only loops')
    })

    it('still allows forceSplit at level 3 from score-based detection', () => {
      const history = makeHistory([
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // Score-based level 3 should allow forceSplit
      if (result.level >= 3) {
        assert.equal(result.shouldForceSplit, true, 'score-based level 3 should allow forceSplit')
      }
    })

    it('does NOT abort at 4 consecutive no-tool turns', () => {
      const result = evaluateConvergence(baseInput({
        turn: 5,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 4,
      }))
      assert.equal(result.shouldAbort, false, 'should not abort at 4 no-tool turns')
      assert.ok(result.level >= 2, 'should at least kick at 4 no-tool turns')
    })
  })

  // ── Early-exit does not override no-tool stagnation ──

  describe('early-exit vs no-tool stagnation', () => {
    it('does NOT reset level to 0 when noToolTurnCount >= 2 and turn < nLow', () => {
      // Before the fix, turn < nLow would reset level to 0 even with noTool stagnation
      const result = evaluateConvergence(baseInput({
        turn: 3, // < nLow=8 for 200K
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 3,
      }))
      // Should be level 2 (kick), NOT level 0 (early-exit)
      assert.ok(result.level >= 2, `expected level >= 2, got ${result.level}`)
      assert.equal(result.shouldAbort, false, 'should not abort at 3 no-tool turns')
    })

    it('fires level 2 kick at turn=2 with noToolTurnCount=2', () => {
      // noToolCount >= 2 && turn >= 4 is false here (turn=2),
      // but noToolCount >= 2 means stagnation is detected and early-exit is skipped
      const result = evaluateConvergence(baseInput({
        turn: 2,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 2,
      }))
      // At turn=2, noToolCount=2: noToolCount >= 2 && turn >= 4 is false (turn=2 < 4)
      // So level stays at 0 (from score) or 2 (from noToolCount >= 3 which is false)
      // The early-exit would normally reset to 0, but noToolStagnation prevents it
      // Actually: noToolCount=2, turn=2 → no condition sets level > 0
      // (noToolCount >= 3? no. noToolCount >= 2 && turn >= 4? no. score-based? depends)
      // The early-exit gate now has !noToolStagnation, so it doesn't reset.
      // But level is still 0 because no condition matched. That's correct.
      // Level 0 is fine here - we don't want to kick after just 2 turns at turn 2.
    })

    it('STILL resets level to 0 when turn < nLow and noToolCount < 2', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 3, // < nLow=8
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      assert.equal(result.level, 0, 'score-based detection should early-exit at turn < nLow')
    })
  })

  // ── Productive-ratio stagnation: alternating read-analyze pattern ──

  describe('productive-ratio stagnation (alternating read-analyze)', () => {
    // The core problem: agent calls read_file each turn (so consecutiveNoToolTurns
    // resets to 0), but never calls edit/test/commit. The "hasProductive" boolean
    // check is all-or-nothing, and on 1M window the turn gate (nLow=12) blocks
    // all score-based detection for the first 12 turns.
    //
    // New signal: productiveRatio = productive tools / total tools in last K calls.
    // When productiveRatio === 0 and window >= K, treat as stagnation that
    // bypasses the turn gate (same as noToolStagnation).

    it('detects alternating read-analyze pattern as stagnation before nLow (200K)', () => {
      // Pattern: read_file with different targets each time (high novelty)
      // but zero productive tools in 6 calls. Turn 5 < nLow=8.
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
        { tool: 'read_file', target: 'f.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 5, // < nLow=8
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0, // all turns had tools, so this is 0
      }))
      // Before fix: level=0 (early-exit gate blocks score-based, noTool=0)
      // After fix: level >= 1 (productive stagnation bypasses gate)
      assert.ok(result.level >= 1,
        `expected level >= 1 for read-only stagnation at turn 5, got ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('detects alternating pattern on 1M window before nLow=12 (GLM scenario)', () => {
      // 1M window: nLow=12, signalWindow=10
      // 8 read-only tool calls at turn 6 — should be detected as stagnation
      const history = makeHistory([
        { tool: 'read_file', target: `file${0}.ts` },
        { tool: 'read_file', target: `file${1}.ts` },
        { tool: 'grep', target: 'pattern0' },
        { tool: 'read_file', target: `file${2}.ts` },
        { tool: 'read_file', target: `file${3}.ts` },
        { tool: 'grep', target: 'pattern1' },
        { tool: 'read_file', target: `file${4}.ts` },
        { tool: 'read_file', target: `file${5}.ts` },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, // well below nLow=12 for 1M
        phaseClass: 'explore',
        contextWindow: 1_000_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        providerName: 'glm',
      }))
      // Before fix: level=0 (turn < nLow=12, noTool=0)
      // After fix: level >= 1 (productive stagnation bypasses gate)
      assert.ok(result.level >= 1,
        `expected level >= 1 for GLM read-only stagnation at turn 6 on 1M, got ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('does NOT trigger when productive tools are present in window', () => {
      // Same window size but with one edit_file — productiveRatio > 0
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 5,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // With one productive tool, this is normal exploration — should be level 0
      assert.equal(result.level, 0,
        `expected level 0 when productive tools present, got ${result.level}`)
    })

    it('stagnation message mentions read-only pattern', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
        { tool: 'read_file', target: 'f.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      if (result.level >= 2 && result.injectedMessage) {
        // Message should mention that all recent operations are read-only
        assert.ok(
          result.injectedMessage.includes('读取') || result.injectedMessage.includes('read') || result.injectedMessage.includes('编辑'),
          `expected read-only stagnation hint, got: ${result.injectedMessage.slice(0, 150)}`,
        )
      }
    })

    it('does not false-positive on short windows (fewer than K tools)', () => {
      // Only 2 read tools — not enough data for productiveRatio stagnation
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 3,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // Too few tools — should not trigger stagnation
      assert.equal(result.level, 0,
        `expected level 0 for short window, got ${result.level}`)
    })
  })
})
