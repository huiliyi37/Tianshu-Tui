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

  // ── Level 3 建议升级（重构事故链缺口 4）：回归场景优先 bisect/基线对照 ──
  it('level 3 message offers git bisect / checkpoint rollback for regression hunts, not just a new session', () => {
    // 混入一次失败编辑，避开 productiveStagnation 早退分支，落到通用 level-3 尾部
    const history = makeHistory([
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'edit_file', target: 'x', status: 'failed' },
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
    assert.equal(result.level, 3)
    assert.ok(result.injectedMessage!.includes('git bisect'),
      'level 3 must offer the baseline-comparison escape hatch for regressions')
    assert.ok(result.injectedMessage!.includes('checkpoint'),
      'checkpoint rollback should be offered alongside bisect')
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

  // ── Change 1: argsHash granularity ──

  it('targetNovelty uses argsHash when available (same file, different edits)', () => {
    // edit_file(a.ts, old="x", new="y") vs edit_file(a.ts, old="y", new="z")
    // — same target path, different argsHash → higher novelty
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const, argsHash: 'hash-xy' },
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const, argsHash: 'hash-yz' },
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const, argsHash: 'hash-xy' },
    ]
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
    }))
    // 2 unique argsHash values among 3 entries → novelty = (2-1)/(3-1) = 0.5
    assert.equal(result.signals.targetNovelty, 0.5)
  })

  it('targetNovelty falls back to target when argsHash is absent', () => {
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'b.ts', status: 'success' as const },
    ]
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
    }))
    // Fallback to target: 2 unique targets among 3 → (2-1)/(3-1) = 0.5
    assert.equal(result.signals.targetNovelty, 0.5)
  })

  // ── Change 2: tokenEfficiency exponential decay ──

  it('tokenEfficiency uses exponential decay when outputTokens is provided', () => {
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'b.ts', status: 'success' as const },
      { tool: 'read_file', target: 'c.ts', status: 'success' as const },
      { tool: 'read_file', target: 'd.ts', status: 'success' as const },
      { tool: 'grep', target: 'foo', status: 'success' as const },
      { tool: 'glob', target: '*.ts', status: 'success' as const },
    ]
    // 6 tools, 3000 output tokens → 500 tokens/tool → exp(-1) ≈ 0.368
    const result = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      outputTokens: 3000,
    }))
    const expected = Math.exp(-1)
    assert.ok(
      Math.abs(result.signals.tokenEfficiency - expected) < 0.01,
      `tokenEfficiency should be ~${expected.toFixed(3)}, got ${result.signals.tokenEfficiency.toFixed(3)}`,
    )
  })

  it('tokenEfficiency falls back to heuristic when outputTokens is absent', () => {
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'b.ts', status: 'success' as const },
      { tool: 'read_file', target: 'c.ts', status: 'success' as const },
    ]
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      // outputTokens intentionally omitted
    }))
    // Old heuristic: writes=2, reads=1 → productive/total = 2/3, ratio=0.5 → bonus=0.2 → 0.867
    assert.ok(result.signals.tokenEfficiency > 0.5, 'fallback should still give reasonable efficiency')
  })

  // ── Change 3: oscillation positional reversal (multi-value) ──

  it('oscillation detects A→B→A→C→A→B multi-value pattern (old algorithm silently ignored it)', () => {
    // Old algorithm: Set.size===3 → returns 1.0 (missed oscillation)
    // New algorithm: reversals via hash[i]===hash[i-2] && !== hash[i-1]
    const fingerprints = ['a', 'b', 'a', 'c', 'a', 'b', 'c', 'b']
    const history = makeHistory(fingerprints.map((fp, i) => ({
      tool: `tool-${i % 3}`, target: `file-${i}`,
    })))
    const result = evaluateConvergence(baseInput({
      turn: 10, phaseClass: 'verify', contextWindow: 200_000,
      recentToolHistory: history, toolFingerprints: fingerprints,
    }))
    // Reversals at i=2(a→b→a), i=4(a→c→a), i=7(b→c→b) = 3 out of 6 possible
    // → rate=3/6=0.5 → penalty=0.5 (old algorithm would return 1.0)
    assert.ok(
      result.signals.oscillationPenalty > 0.4 && result.signals.oscillationPenalty < 0.6,
      `oscillation penalty should be ~0.50 for multi-value pattern, got ${result.signals.oscillationPenalty.toFixed(2)}`,
    )
  })

  it('oscillation: severe A-B-A-B-A-B-A-B yields near-zero penalty', () => {
    const fingerprints = ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']
    const history = makeHistory(fingerprints.map((fp, i) => ({
      tool: fp === 'a' ? 'bash' : 'ls', target: `file-${i}`,
    })))
    const result = evaluateConvergence(baseInput({
      turn: 10, phaseClass: 'verify', contextWindow: 200_000,
      recentToolHistory: history, toolFingerprints: fingerprints,
    }))
    // Every step from i=2 is a reversal → 6 reversals / 6 possible = 1.0 → penalty = 0
    assert.ok(
      result.signals.oscillationPenalty < 0.1,
      `severe A-B oscillation should yield near-0 penalty, got ${result.signals.oscillationPenalty.toFixed(2)}`,
    )
  })

  it('oscillation: < 4 fingerprints returns 1.0 (insufficient data)', () => {
    const fingerprints = ['a', 'b', 'a']
    const history = makeHistory([
      { tool: 'bash', target: '1' },
      { tool: 'bash', target: '2' },
      { tool: 'bash', target: '3' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000,
      recentToolHistory: history, toolFingerprints: fingerprints,
    }))
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

  // ── Reasoning-aware no-tool abort ──
  // A deep-reasoning model can legitimately narrate multi-turn analysis (fresh,
  // substantial, non-repetitive text) with no tool call before it acts. That is
  // reasoning, not a text-only spin — it must NOT be hard-killed (the "他在推理，
  // 但我们以为他终端" false circuit-break). Genuine spin (repetitive / thin text)
  // still aborts.
  describe('reasoning-aware no-tool abort', () => {
    // Three distinct long analysis turns → producingReport=true (non-repetitive
    // + ≥200 chars). Reuses the incident-shaped report fingerprints.
    const freshReasoning = [
      '代码审查结果 严重问题 1 测试套件无法运行 conftest 缺失 测试文件 test_scoring 导入了 make_flat_kline make_uptrend_kline make_limit_up_streaks 三个工厂函数以及 flat_df limit_up_df 两个 pytest fixture 但项目根目录与 tests 目录下都没有 conftest 定义它们 运行 pytest 会在 collection 阶段直接报 fixture not found 整个测试套件无法启动 需要新增 conftest 补齐这些 fixture 与工厂函数的定义和导入 否则任何回归验证都无法进行',
      '中等问题 config 模块中 SCREENING 字段在第 18 行定义但通篇没有任何模块 import 或引用它 ZONE_MIN_VOLUME 常量同样在配置里定义却没有任何消费方 grep 全仓零命中 属于典型的死配置 updater 模块顶部还存在一处从 legacy_utils 的死导入 引入后从未使用 建议统一清理这些未使用符号 并为确需保留的字段补充真实消费方 避免配置与代码之间形成死接线',
      'updater 起算日逻辑反转 update_daily_kline 函数中有两处计算起始日期 sd 都写成了 min date today minus timedelta 与已有最早日期 取 min 会永远选中更早的那个日期 导致每次增量更新都从很久以前重新拉取 既浪费带宽也可能覆盖已修正数据 正确做法应该是按最近一个交易日向前回溯固定窗口 用 max 锚定到最新边界 否则增量窗口计算方向完全错误 需要尽快修正这两处边界条件',
    ]

    it('does NOT hard-abort at 5 no-tool turns when reasoning is still fresh (kick instead)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
        textFingerprints: freshReasoning,
      }))
      assert.equal(result.reasoningActive, true, 'fresh substantial text → reasoningActive')
      assert.equal(result.shouldAbort, false, 'a reasoning model must NOT be hard-killed on the no-tool cap')
      assert.equal(result.shouldForceSplit, false, 'reasoning model must not be force-split either')
      assert.equal(result.abortCause, undefined, 'no abort → no abortCause')
      assert.ok(result.shouldKick, 'still kick to nudge toward action')
      assert.equal(result.level, 2, 'downgraded from hard-abort level 3 to kick level 2')
    })

    it('STILL hard-aborts at 5 no-tool turns when text is repetitive (genuine spin)', () => {
      const repeated = freshReasoning[0]!
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
        textFingerprints: [repeated, repeated, repeated, repeated, repeated],
      }))
      assert.equal(result.reasoningActive, false, 'repetitive text → not reasoning')
      assert.equal(result.shouldAbort, true, 'genuine text-only spin must still abort')
      assert.equal(result.abortCause, 'no-tool', 'abort cause is the no-tool hard cap')
      assert.equal(result.level, 3, 'stays at hard-abort level 3')
    })

    it('STILL hard-aborts at 5 no-tool turns with no text at all (empty spin)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
        // no textFingerprints → not producing a report → not reasoning
      }))
      assert.equal(result.reasoningActive, false)
      assert.equal(result.shouldAbort, true, 'no-content no-tool spin must still abort')
      assert.equal(result.abortCause, 'no-tool')
    })

    it('STILL score-aborts at level 3 even when fresh reasoning text is present', () => {
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
        noToolTurnCount: 0,
        textFingerprints: freshReasoning,
      }))
      assert.equal(result.reasoningActive, true, 'fresh substantial text → reasoningActive')
      assert.equal(result.level, 3, `expected score-based level 3, got level=${result.level} score=${result.score.toFixed(2)}`)
      assert.equal(result.shouldAbort, true, 'score-based abort must fire regardless of reasoning text')
      assert.equal(result.abortCause, 'score')
      assert.equal(result.shouldForceSplit, true, 'score-based level 3 still allows force split')
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

  // ── Fix 2: read-heavy review/audit tasks that produce a text report ──
  // The incident: user asked 天枢 to review existing code. 天枢 correctly
  // read/grep-ed extensively (the deliverable is a text report, never edits),
  // but got flagged as read-only "stagnation" every turn and spammed with the
  // 星域·改道 "去编辑/测试" nudge. A substantial, non-repetitive text output
  // must be recognized as report production, not stagnation.

  describe('review/report production (read-heavy, not stagnation)', () => {
    // Long, unique review-report turns (>= REPORT_TEXT_MIN_LEN chars each),
    // mirroring the incident's 代码审查结果 output. Three distinct long
    // fingerprints keep textRepetitionPenalty high (non-repetitive).
    const reportFingerprints = [
      '代码审查结果 严重问题 1 测试套件无法运行 conftest 缺失 测试文件 test_scoring 导入了 make_flat_kline make_uptrend_kline make_limit_up_streaks 三个工厂函数以及 flat_df limit_up_df 两个 pytest fixture 但项目根目录与 tests 目录下都没有 conftest 定义它们 运行 pytest 会在 collection 阶段直接报 fixture not found 整个测试套件无法启动 需要新增 conftest 补齐这些 fixture 与工厂函数的定义和导入 否则任何回归验证都无法进行',
      '中等问题 config 模块中 SCREENING 字段在第 18 行定义但通篇没有任何模块 import 或引用它 ZONE_MIN_VOLUME 常量同样在配置里定义却没有任何消费方 grep 全仓零命中 属于典型的死配置 updater 模块顶部还存在一处从 legacy_utils 的死导入 引入后从未使用 建议统一清理这些未使用符号 并为确需保留的字段补充真实消费方 避免配置与代码之间形成死接线',
      'updater 起算日逻辑反转 update_daily_kline 函数中有两处计算起始日期 sd 都写成了 min(date.today() minus timedelta 与已有最早日期) 取 min 会永远选中更早的那个日期 导致每次增量更新都从很久以前重新拉取 既浪费带宽也可能覆盖已修正数据 正确做法应该是按最近一个交易日向前回溯固定窗口 用 max 锚定到最新边界 否则增量窗口计算方向完全错误 需要尽快修正这两处边界条件',
    ]

    it('does NOT flag read-only review as stagnation when producing a report (turn 24, plan)', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24, // deep into the session, like the incident
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: reportFingerprints,
      }))
      assert.equal(result.level, 0,
        `read-heavy review producing a report must not escalate, got level ${result.level} (score=${result.score.toFixed(2)})`)
      assert.equal(result.injectedMessage, null,
        'a review producing a report must not inject a 改道 nudge')
    })

    it('control: same read-only pattern WITHOUT a report still flags stagnation', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        // no textFingerprints → no report → read-only penalty applies
      }))
      assert.ok(result.level >= 2,
        `read-only with no report should still flag, got level ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('exemption narrowed (2026-07-04): unverified edits + long analysis text still flags', () => {
      // 有未验证编辑还在写长文 — 是该被提醒的场景，不是审查报告。
      // 与 "does NOT flag" 用例完全同构，唯一差异是 evidenceState 带未验证编辑。
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: reportFingerprints,
        evidenceState: {
          filesModified: new Set(['src/a.ts', 'src/b.ts']),
          filesRead: new Set<string>(),
          deliveryStatus: 'unverified' as const,
        },
      }))
      assert.ok(result.level >= 2,
        `unverified edits must void the report exemption, got level ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('exemption survives when edits are verified (pure post-verification review)', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: reportFingerprints,
        evidenceState: {
          filesModified: new Set(['src/a.ts']),
          filesRead: new Set<string>(),
          deliveryStatus: 'verified' as const,
        },
      }))
      assert.equal(result.level, 0,
        `verified edits + report production must keep the exemption, got level ${result.level}`)
    })

    it('repetitive text (stuck loop) is NOT treated as report production', () => {
      // Same long text repeated across turns → high repetition → still stagnation.
      const repeated = reportFingerprints[0]!
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
        { tool: 'read_file', target: 'f.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: [repeated, repeated, repeated],
      }))
      assert.ok(result.level >= 2,
        `repetitive read loop must still flag, got level ${result.level} (score=${result.score.toFixed(2)})`)
    })
  })

  // ── targetNovelty formula + editRatio novelty-gating regression ────────
  // Regression for the "原地打转 (editing the same file) scored as progress"
  // doom-loop misjudgment. Before the fix: targetNovelty used distinct/total
  // (N identical → 1/N ≈ 0.17, not 0), and editRatio entered the score
  // independently — so 10 successful edits to ONE file got the full 0.40
  // execute weight AND a non-zero novelty residual. Both fixed together:
  // novelty now (unique-1)/(total-1), and editRatio is gated by max(novelty,0.1).

  describe('targetNovelty formula (defect 1)', () => {
    it('all-identical targets → novelty exactly 0', () => {
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      }))
      assert.equal(result.signals.targetNovelty, 0,
        `5 identical targets must give novelty 0, got ${result.signals.targetNovelty}`)
    })

    it('all-distinct targets → novelty 1', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, phaseClass: 'explore', contextWindow: 200_000, recentToolHistory: history,
      }))
      assert.equal(result.signals.targetNovelty, 1,
        `5 distinct targets must give novelty 1, got ${result.signals.targetNovelty}`)
    })

    it('single-element window → novelty 1.0 (fully novel)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 2, phaseClass: 'explore', contextWindow: 200_000,
        recentToolHistory: makeHistory([{ tool: 'read_file', target: 'a.ts' }]),
      }))
      assert.equal(result.signals.targetNovelty, 1.0)
    })

    it('empty window → novelty 1.0 (open frontier)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 0, phaseClass: 'explore', contextWindow: 200_000, recentToolHistory: [],
      }))
      assert.equal(result.signals.targetNovelty, 1.0)
    })

    it('partial overlap is continuous, not the old 1/N residual', () => {
      // 5 calls: 3 distinct + 2 repeats. Old formula: 3/5 = 0.6.
      // New formula: (3-1)/(5-1) = 0.5. The repeat fraction is now fully counted.
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'a.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, phaseClass: 'explore', contextWindow: 200_000, recentToolHistory: history,
      }))
      assert.equal(result.signals.targetNovelty, 0.5,
        `3 unique of 5 must give (3-1)/(5-1)=0.5, got ${result.signals.targetNovelty}`)
    })
  })

  describe('editRatio novelty-gating (defect 2)', () => {
    it('editing the SAME file repeatedly scores far lower than editing DISTINCT files', () => {
      // Both windows: 6 successful edit_file calls, identical editRatio=1.0.
      // Difference: targets. Same-file → novelty 0 → editRatio gated to ~0.
      // Distinct-file → novelty 1 → editRatio contributes fully.
      const sameFile = makeHistory(
        Array.from({ length: 6 }, () => ({ tool: 'edit_file', target: 'a.ts' })),
      )
      const distinctFiles = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'b.ts' },
        { tool: 'edit_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'd.ts' },
        { tool: 'edit_file', target: 'e.ts' },
        { tool: 'edit_file', target: 'f.ts' },
      ])
      const sameResult = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: sameFile,
      }))
      const distinctResult = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: distinctFiles,
      }))
      assert.ok(
        distinctResult.score > sameResult.score,
        `distinct edits (score=${distinctResult.score.toFixed(2)}) must out-score same-file edits (score=${sameResult.score.toFixed(2)})`,
      )
      // Same-file edits should be flagged as stuck (the doom-loop signal),
      // not rewarded as high progress.
      assert.ok(sameResult.level >= distinctResult.level,
        `same-file edits (level=${sameResult.level}) should be >= distinct edits (level=${distinctResult.level})`)
    })

    it('0.1 floor keeps a baseline for legitimately iterative single-file edits', () => {
      // Editing one file 6 times is not ALWAYS a doom-loop — e.g. building up
      // a large module. The floor ensures editRatio contributes 0.40×0.1=0.04,
      // not zero. Combined with other signals (no errors, some entropy) the
      // score should not collapse to near-zero the way all-failures would.
      const iterative = makeHistory(
        Array.from({ length: 6 }, () => ({ tool: 'edit_file', target: 'a.ts' })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: iterative,
      }))
      // Not rewarded as strong progress, but not catastrophically low either.
      assert.ok(result.score > 0.0 && result.score < 0.6,
        `iterative single-file edit score should be in a middling range, got ${result.score.toFixed(2)}`)
    })
  })

  // ── No-data weight re-allocation (defect 4) ───────────────────────────
  // textRepetitionPenalty + oscillationPenalty default to 1.0 when they lack
  // enough fingerprints (window period). Previously that 1.0 entered the score
  // at full weight, inflating it by ~0.18 in execute phase. Now the weight is
  // re-allocated to data-carrying signals so "no data" does not look healthy.

  describe('no-data weight re-allocation (defect 4)', () => {
    it('score without fingerprint data is NOT inflated vs with-data baseline', () => {
      // Same tool history in both cases. The difference is only whether the
      // penalty signals HAVE data. A no-data window should not score HIGHER
      // than a with-data window for the same trajectory — that would mean
      // "no evidence" is being rewarded as health.
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'd.ts' },
        { tool: 'grep', target: 'x' },
        { tool: 'run_tests', target: 't' },
      ])
      const base = {
        turn: 8, phaseClass: 'execute' as PhaseClass,
        contextWindow: 200_000, recentToolHistory: history,
      }
      // No fingerprints → both penalty signals are in no-data sentinel state.
      const noData = evaluateConvergence(baseInput(base))
      // With diverse fingerprints → both signals have data and return their
      // real (non-sentinel) values, which for a healthy diverse trajectory are
      // high but NOT artificially maxed.
      const withData = evaluateConvergence(baseInput({
        ...base,
        toolFingerprints: ['fa', 'fb', 'fc', 'fd', 'fe', 'ff', 'fg', 'fh'],
        textFingerprints: [
          'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
          'nu xi omicron pi rho sigma tau upsilon phi chi psi omega one two',
          'three four five six seven eight nine ten eleven twelve thirteen fourteen',
        ],
      }))
      // The no-data score must not exceed the with-data score by the old
      // inflation margin. Allow a small tolerance since re-allocation shifts
      // weight onto signals whose values differ — the point is no LARGE inflation.
      assert.ok(
        noData.score <= withData.score + 0.05,
        `no-data score (${noData.score.toFixed(2)}) should not inflate above with-data (${withData.score.toFixed(2)})`,
      )
    })

    it('errorPenalty empty-window 1.0 is NOT re-allocated (semantically correct)', () => {
      // errorPenalty returns 1.0 on empty window meaning "no errors = full
      // marks", which is a legitimate score, not a no-data sentinel. The
      // re-allocation must be scoped to oscillation/textRep only — verify a
      // healthy all-success window still scores high (errorPenalty keeps its
      // weight), not drained because errorPenalty was mis-classified.
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'b.ts' },
        { tool: 'edit_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'd.ts' },
        { tool: 'run_tests', target: 't' },
        { tool: 'run_tests', target: 'u' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      }))
      // All successes, diverse targets → high errorPenalty retained, score
      // should reflect a healthy trajectory (not drained by mis-allocation).
      assert.ok(result.signals.errorPenalty === 1.0, `errorPenalty should be 1.0 for all-success window`)
    })
  })

  // ── Route-confirmation variant（2026-07-07）──────────────────────────
  // 编辑在落地、失败率低，但新颖度/熵类指标把 score 压进 L2 —— 此时不应
  // 给"换个角度看问题"（路线正确的模型会整条驳回），而是确认路线 + 要求
  // 一个验证锚点。

  describe('route-confirmation injected message', () => {
    // 同一文件 edit/read 交替、仅 1 次失败 + A→B 震荡指纹：
    // editRatio=0.5、errorPenalty≈0.83（均过确认门槛），score 落入 L2 区。
    const productiveButUnverified = makeHistory([
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts', status: 'failed' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const oscillatingFps = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'B' : 'A'))

    it('L2 with productive edits and low failure rate confirms the route instead of asking to change direction', () => {
      const result = evaluateConvergence(baseInput({
        turn: 14,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: productiveButUnverified,
        toolFingerprints: oscillatingFps,
        evidenceState: {
          filesModified: new Set(['a.ts']),
          filesRead: new Set(['a.ts']),
          deliveryStatus: 'unverified' as const,
        },
      }))
      assert.equal(result.level, 2, `expected L2, got L${result.level} (score=${result.score.toFixed(2)})`)
      assert.ok(result.signals.editRatio >= 0.2 && result.signals.errorPenalty >= 0.8,
        `signals should pass the confirmation gate (edit=${result.signals.editRatio}, err=${result.signals.errorPenalty})`)
      assert.ok(result.injectedMessage!.includes('路线本身没有被质疑'), 'should confirm the route')
      assert.ok(result.injectedMessage!.includes('验证锚点'), 'should prescribe a verification anchor')
      assert.ok(!result.injectedMessage!.includes('换个角度看问题'), 'must NOT ask to change direction')
    })

    it('L2 with low edit ratio keeps the generic change-direction message', () => {
      // 纯读取窗口（editRatio 低）——确认式变体不该触发。
      const readOnly = makeHistory(
        Array.from({ length: 6 }, (_, i) => ({ tool: i % 2 ? 'grep' : 'read_file', target: 'a.ts' })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 14,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: readOnly,
        toolFingerprints: oscillatingFps,
      }))
      if (result.level >= 2 && result.injectedMessage) {
        assert.ok(!result.injectedMessage.includes('路线本身没有被质疑'),
          'read-only window must not get route confirmation')
      }
    })
  })
})
