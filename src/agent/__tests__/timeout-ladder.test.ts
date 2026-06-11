import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  progressiveTimeout,
  assertLadderInvariant,
  capBudgetAtTool,
  SSE_IDLE_MS,
  HARD_STALL_MS,
  DEFAULT_WORKER_BUDGET_MS,
} from '../timeout-ladder.js'

describe('timeout ladder', () => {
  describe('progressiveTimeout — arithmetic sequence', () => {
    it('returns 60s for cold open (turn 0-1)', () => {
      assert.equal(progressiveTimeout(0), 60_000)
      assert.equal(progressiveTimeout(1), 60_000)
    })

    it('returns 120s for warming (turn 2-4)', () => {
      assert.equal(progressiveTimeout(2), 120_000)
      assert.equal(progressiveTimeout(3), 120_000)
      assert.equal(progressiveTimeout(4), 120_000)
    })

    it('returns 180s for mature (turn 5+)', () => {
      assert.equal(progressiveTimeout(5), 180_000)
      assert.equal(progressiveTimeout(10), 180_000)
      assert.equal(progressiveTimeout(100), 180_000)
    })

    it('defaults to mature (180s) when turn is undefined', () => {
      assert.equal(progressiveTimeout(undefined), 180_000)
    })

    it('has common difference of 60s between each tier', () => {
      const cold = progressiveTimeout(0)
      const warming = progressiveTimeout(3)
      const mature = progressiveTimeout(10)
      assert.equal(warming - cold, 60_000, 'warming - cold must be 60s')
      assert.equal(mature - warming, 60_000, 'mature - warming must be 60s')
    })

    it('sequence is monotonically non-decreasing', () => {
      let prev = 0
      for (let turn = 0; turn <= 20; turn++) {
        const v = progressiveTimeout(turn)
        assert.ok(v >= prev, `turn ${turn}: ${v} < prev ${prev}`)
        prev = v
      }
    })
  })

  describe('ladder invariant — SSE_idle < budget ≤ tool ≤ hardStall', () => {
    it('holds at every maturity level', () => {
      for (const turn of [0, 3, 10]) {
        const tool = progressiveTimeout(turn)
        const budget = capBudgetAtTool(DEFAULT_WORKER_BUDGET_MS, tool)
        assert.ok(
          SSE_IDLE_MS < budget,
          `SSE(${SSE_IDLE_MS}) must be < budget(${budget}) @turn${turn}`,
        )
        assert.ok(budget <= tool, `budget(${budget}) must be ≤ tool(${tool}) @turn${turn}`)
        assert.ok(
          tool <= HARD_STALL_MS,
          `tool(${tool}) must be ≤ hardStall(${HARD_STALL_MS}) @turn${turn}`,
        )
      }
    })

    it('passes for a well-formed ladder', () => {
      assert.doesNotThrow(() =>
        assertLadderInvariant({
          sseIdle: 45_000,
          budget: 60_000,
          tool: 60_000,
          hardStall: 240_000,
        }),
      )
    })

    it('throws when SSE idle ≥ budget', () => {
      assert.throws(
        () => assertLadderInvariant({ sseIdle: 100_000, budget: 60_000, tool: 120_000, hardStall: 240_000 }),
        /SSE idle.*must be < budget/,
      )
    })

    it('throws when budget > tool', () => {
      assert.throws(
        () => assertLadderInvariant({ sseIdle: 45_000, budget: 180_000, tool: 60_000, hardStall: 240_000 }),
        /budget.*must be ≤ tool/,
      )
    })

    it('throws when tool > hardStall', () => {
      assert.throws(
        () => assertLadderInvariant({ sseIdle: 45_000, budget: 60_000, tool: 300_000, hardStall: 240_000 }),
        /tool.*must be ≤ hardStall/,
      )
    })
  })

  describe('capBudgetAtTool', () => {
    it('caps budget at tool timeout', () => {
      assert.equal(capBudgetAtTool(180_000, 60_000), 60_000)
      assert.equal(capBudgetAtTool(180_000, 120_000), 120_000)
    })

    it('returns budget unchanged when no tool timeout specified', () => {
      assert.equal(capBudgetAtTool(180_000, undefined), 180_000)
    })

    it('returns budget when budget < tool', () => {
      assert.equal(capBudgetAtTool(60_000, 180_000), 60_000)
    })

    it('handles equal values', () => {
      assert.equal(capBudgetAtTool(180_000, 180_000), 180_000)
    })
  })

  describe('RED — counterexamples that catch lazy implementations', () => {
    it('rejects the old 30/75/180 non-arithmetic curve (old delegate-task)', () => {
      const oldCold = 30_000
      const oldWarming = 75_000
      const oldMature = 180_000
      assert.notEqual(oldWarming - oldCold, 60_000, 'old 30→75 was NOT arithmetic (Δ45)')
      assert.notEqual(oldMature - oldWarming, 60_000, 'old 75→180 was NOT arithmetic (Δ105)')
      // new curve must be arithmetic
      assert.equal(progressiveTimeout(3) - progressiveTimeout(0), 60_000)
    })

    it('rejects the old 45/90/180 non-arithmetic curve (old delegate-batch)', () => {
      const oldCold = 45_000
      const oldWarming = 90_000
      const oldMature = 180_000
      assert.notEqual(oldWarming - oldCold, 60_000, 'old 45→90 was NOT arithmetic (Δ45)')
      assert.notEqual(oldMature - oldWarming, 60_000, 'old 90→180 was NOT arithmetic (Δ90)')
    })

    it('catches a budget that exceeds tool (the R3 invariant violation)', () => {
      // old behavior: budget=180s fixed, tool=60s cold → budget > tool
      const fixedBudget = 180_000
      const coldTool = progressiveTimeout(0)
      assert.ok(fixedBudget > coldTool, 'old fixed budget DID exceed cold tool')
      // new behavior: capped
      assert.ok(
        capBudgetAtTool(fixedBudget, coldTool) <= coldTool,
        'capped budget must not exceed tool',
      )
    })
  })
})
