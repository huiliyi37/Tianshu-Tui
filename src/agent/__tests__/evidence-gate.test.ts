import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectEvidenceGate,
  type ToolHistoryEntry,
  type EvidenceGateResult,
} from '../evidence-gate.js'

/** Helper: build a single tool history entry */
function entry(tool: string, target: string | undefined, turn: number): ToolHistoryEntry {
  return { tool, target, turn }
}

describe('detectEvidenceGate', () => {
  it('returns inactive when no tool history', () => {
    const result = detectEvidenceGate({ recentHistory: [], currentTurn: 1 })
    assertResultInactive(result)
  })

  it('returns inactive when only probes exist, no decision tools', () => {
    const history = [
      entry('read_file', 'src/foo.ts', 1),
      entry('grep', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assertResultInactive(result)
  })

  it('detects active evidence: probe → same-target write within window', () => {
    const history = [
      entry('read_file', 'src/foo.ts', 1),
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assert.ok(result.active, 'should be active when probe→write pair exists')
    assert.ok(result.closures >= 1, 'should have at least 1 closure')
  })

  it('detects active evidence: grep → same-target edit within window', () => {
    const history = [
      entry('grep', 'src/bar.ts', 3),
      entry('edit_file', 'src/bar.ts', 4),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 5 })
    assert.ok(result.active)
    assert.ok(result.closures >= 1)
  })

  it('detects active evidence: run_tests → same-target edit (test output consumed)', () => {
    const history = [
      entry('run_tests', 'src/foo.test.ts', 1),
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    // run_tests target is test file; edit target is source — cross-target is valid
    // because the "result" of run_tests is consumed by the subsequent edit
    assert.ok(result.active)
    assert.ok(result.closures >= 1)
  })

  it('does NOT count closures when target is empty or undefined', () => {
    const history = [
      entry('read_file', undefined, 1),
      entry('edit_file', undefined, 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    // Degradation: empty target doesn't count as closure, doesn't penalize
    assertResultInactive(result)
  })

  it('does NOT count closures outside window (N=6 turns)', () => {
    const history = [
      entry('read_file', 'src/old.ts', 1),
      entry('edit_file', 'src/old.ts', 10), // 9 turns apart, window is 6
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 11, windowTurns: 6 })
    assertResultInactive(result)
  })

  it('detects multiple closures in multi-file cross scenario', () => {
    const history = [
      entry('read_file', 'src/a.ts', 1),
      entry('read_file', 'src/b.ts', 1),
      entry('edit_file', 'src/a.ts', 2),
      entry('edit_file', 'src/b.ts', 3),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 4 })
    assert.ok(result.active)
    assert.ok(result.closures >= 2, `expected >=2 closures, got ${result.closures}`)
  })

  it('handles run_tests → write_file with matching target', () => {
    const history = [
      entry('run_tests', 'src/foo.test.ts', 1),
      entry('write_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assert.ok(result.active)
  })

  it('treats bash dry-run probe as valid probe', () => {
    const history = [
      entry('bash', 'npm run typecheck', 1),
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assert.ok(result.active)
    assert.ok(result.closures >= 1)
  })

  it('does not count write→write as closure (no probe first)', () => {
    const history = [
      entry('edit_file', 'src/foo.ts', 1),
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assertResultInactive(result)
  })

  it('respects custom windowTurns', () => {
    const history = [
      entry('read_file', 'src/foo.ts', 1),
      entry('edit_file', 'src/foo.ts', 4),
    ]
    // window=3: turns 1 and 4 are 3 apart, should be within
    const result3 = detectEvidenceGate({ recentHistory: history, currentTurn: 5, windowTurns: 3 })
    assert.ok(result3.active, 'window=3 should include turns 1→4')

    // window=2: 3 apart, should be outside
    const result2 = detectEvidenceGate({ recentHistory: history, currentTurn: 5, windowTurns: 2 })
    assertResultInactive(result2)
  })

  it('produces correct score: closures / max(1, closureDenominator)', () => {
    // 1 closure out of 1 decision assertion → score 1.0 → active
    const history = [
      entry('read_file', 'src/foo.ts', 1),
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assert.ok(result.score >= 0.5, `score should be >= 0.5 for active, got ${result.score}`)
  })

  // ── BASH_PROBE_RE 扩展：微探针执行 + 取证型只读 bash ──

  it('treats tsx -e micro-probe as valid probe', () => {
    const history: ToolHistoryEntry[] = [
      { tool: 'bash', target: undefined, turn: 1, command: `npx tsx -e "import { f } from './src/foo.js'; console.log(f(1))"` },
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    // bash probe has no target → not counted as closure, but must not be a decision either
    assert.ok(!result.active || result.closures >= 0)
    // The real assertion: a tsx -e command with a target IS a probe closure source
    const withTarget: ToolHistoryEntry[] = [
      { tool: 'bash', target: 'tsx probe', turn: 1, command: `npx tsx -e "console.log(1)"` },
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const r2 = detectEvidenceGate({ recentHistory: withTarget, currentTurn: 3 })
    assert.ok(r2.active, 'tsx -e should classify as bash probe')
    assert.ok(r2.closures >= 1)
  })

  it('treats node -e micro-probe as valid probe', () => {
    const history: ToolHistoryEntry[] = [
      { tool: 'bash', target: 'node probe', turn: 1, command: `node -e 'console.log(require("./pkg.json"))'` },
      entry('edit_file', 'src/foo.ts', 2),
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
    assert.ok(result.active, 'node -e should classify as bash probe')
  })

  it('treats evidence-gathering grep flags (-c/-n/-o) as probes', () => {
    for (const cmd of [
      `grep -n 'checkPositive' src/agent/advisory-readback.ts`,
      `grep -c 'export' src/agent/loop.ts`,
      `grep -rno 'pattern' src/`,
    ]) {
      const history: ToolHistoryEntry[] = [
        { tool: 'bash', target: cmd, turn: 1, command: cmd },
        entry('edit_file', 'src/foo.ts', 2),
      ]
      const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
      assert.ok(result.active, `expected probe classification for: ${cmd}`)
    }
  })

  it('treats wc -l and head -n as probes, including pipeline tails', () => {
    for (const cmd of [
      `wc -l src/agent/loop.ts`,
      `head -n 40 src/agent/evidence.ts`,
      `head -20 README.md`,
      `git stash list | grep -c stash`,
      `cat file.ts | wc -l`,
    ]) {
      const history: ToolHistoryEntry[] = [
        { tool: 'bash', target: cmd, turn: 1, command: cmd },
        entry('edit_file', 'src/foo.ts', 2),
      ]
      const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
      assert.ok(result.active, `expected probe classification for: ${cmd}`)
    }
  })

  it('does NOT classify plain write-ish bash as probe', () => {
    for (const cmd of [
      `git stash`,
      `rm -rf dist`,
      `echo hello > out.txt`,
      `grep foo src/bar.ts`, // 无统计 flag 的裸 grep 不算（避免过宽）
    ]) {
      const history: ToolHistoryEntry[] = [
        { tool: 'bash', target: cmd, turn: 1, command: cmd },
        entry('edit_file', 'src/foo.ts', 2),
      ]
      const result = detectEvidenceGate({ recentHistory: history, currentTurn: 3 })
      assert.equal(result.active, false, `expected non-probe for: ${cmd}`)
    }
  })

  it('produces low score when many decisions but few closures', () => {
    const history = [
      entry('read_file', 'src/a.ts', 1),
      entry('edit_file', 'src/b.ts', 2), // no probe for b.ts
      entry('edit_file', 'src/c.ts', 3), // no probe for c.ts
      entry('edit_file', 'src/d.ts', 4), // no probe for d.ts
    ]
    const result = detectEvidenceGate({ recentHistory: history, currentTurn: 5 })
    // 0 closures / 3 decisions = score 0 → inactive
    assertResultInactive(result)
  })
})

function assertResultInactive(result: EvidenceGateResult): void {
  assert.equal(result.active, false, `expected inactive, got active with closures=${result.closures}`)
}
