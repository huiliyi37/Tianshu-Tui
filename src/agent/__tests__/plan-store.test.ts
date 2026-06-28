import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// plan-store is a module-level singleton — we test it directly.
// Each test starts from a clean slate by clearing the store via
// consumePlan (which reads + clears).

import { storePlan, consumePlan, getStoredPlan } from '../plan-store.js'

function clearStore(): void {
  consumePlan() // consume clears; call until null
  while (consumePlan()) { /* empty */ }
}

describe('plan-store', () => {
  beforeEach(() => {
    clearStore()
  })

  describe('storePlan + consumePlan', () => {
    it('returns stored JSON and clears after consume', () => {
      const json = '{"mission":"test"}'
      storePlan(json)
      assert.equal(getStoredPlan(), json)
      assert.equal(consumePlan(), json)
      assert.equal(consumePlan(), null)
      assert.equal(getStoredPlan(), null)
    })

    it('consumePlan returns null when store is empty', () => {
      assert.equal(consumePlan(), null)
    })

    it('getStoredPlan does NOT consume', () => {
      const json = '{"mission":"peek"}'
      storePlan(json)
      assert.equal(getStoredPlan(), json)
      assert.equal(getStoredPlan(), json) // still there
      assert.equal(consumePlan(), json)   // now consumed
      assert.equal(getStoredPlan(), null)
    })

    it('storePlan overwrites previous plan', () => {
      storePlan('{"first":1}')
      storePlan('{"second":2}')
      assert.equal(consumePlan(), '{"second":2}')
      assert.equal(consumePlan(), null)
    })
  })

  describe('multi-wave continuity', () => {
    it('consume + re-store keeps plan available for next wave', () => {
      const json = '{"mission":"multi-wave"}'
      storePlan(json)

      // Wave 1: consume + re-store
      const w1 = consumePlan()
      assert.equal(w1, json)
      storePlan(w1!) // team_orchestrate re-stores

      // Wave 2: still available
      const w2 = consumePlan()
      assert.equal(w2, json)
      storePlan(w2!)

      // Wave 3: still available
      assert.equal(consumePlan(), json)
    })

    it('explicit planJson skips store and does not clear it', () => {
      const stored = '{"mission":"stored"}'
      storePlan(stored)

      // Simulating explicit planJson path: don't consume, peek only
      assert.equal(getStoredPlan(), stored)

      // Later wave without explicit: consume works
      assert.equal(consumePlan(), stored)
    })
  })

  describe('cross-plan_task isolation', () => {
    it('new plan_task overwrites stale plan from previous invocation', () => {
      storePlan('{"old":true}')
      storePlan('{"new":true}') // new plan_task call overwrites
      assert.equal(consumePlan(), '{"new":true}')
      assert.equal(consumePlan(), null)
    })
  })
})
