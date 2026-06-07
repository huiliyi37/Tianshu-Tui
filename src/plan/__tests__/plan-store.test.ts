import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writePlan, readPlan, listPlans, approvePlan, rejectPlan, deletePlan, slugify } from '../plan-store.js'
import { checked, checkedAt } from '../../utils/guard.js'

describe('slugify', () => {
  it('converts spaces and special chars to hyphens', () => {
    assert.equal(slugify('Fix memory leak in loop.ts'), 'fix-memory-leak-in-loop-ts')
  })

  it('preserves Chinese characters', () => {
    assert.equal(slugify('修复 内存泄露'), '修复-内存泄露')
  })

  it('trims leading/trailing hyphens', () => {
    assert.equal(slugify('  hello world!  '), 'hello-world')
  })

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100) + '-b'.repeat(50)
    const result = slugify(long)
    assert.ok(result.length <= 80)
  })

  it('returns "plan" for input with no valid chars', () => {
    assert.equal(slugify('!!!'), 'plan')
  })
})

describe('plan-store CRUD', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-test-'))
    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  }

  it('writePlan creates file and returns relative path', async () => {
    const { dir, cleanup } = setup()
    try {
      const relPath = await writePlan(dir, 'fix-bug', '# Fix Bug\n\nDescription here.')
      assert.equal(relPath, '.rivet/plans/fix-bug.md')
      assert.ok(existsSync(join(dir, '.rivet/plans/fix-bug.md')))
    } finally {
      cleanup()
    }
  })

  it('readPlan returns parsed document', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'my-plan', '# My Plan\n\nSome content.')
      const plan = await readPlan(dir, 'my-plan')
      assert.ok(plan)
      assert.equal(checked(plan).title, 'My Plan')
      assert.equal(checked(plan).status, 'submitted')
      assert.equal(checked(plan).slug, 'my-plan')
    } finally {
      cleanup()
    }
  })

  it('listPlans returns sorted by creation time', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'plan-b', '# B')
      await new Promise(r => setTimeout(r, 50))
      await writePlan(dir, 'plan-a', '# A')
      const plans = await listPlans(dir)
      assert.equal(plans.length, 2)
      // Most recent first
      assert.equal(checkedAt(plans, 0).slug, 'plan-a')
      assert.equal(checkedAt(plans, 1).slug, 'plan-b')
    } finally {
      cleanup()
    }
  })

  it('approvePlan marks plan as approved', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'my-plan', '# My Plan\n\nContent.')
      const approved = await approvePlan(dir, 'my-plan')
      assert.ok(approved)
      assert.equal(checked(approved).status, 'approved')
    } finally {
      cleanup()
    }
  })

  it('rejectPlan marks plan as rejected without deleting it', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'doomed-plan', '# Doomed Plan\n\nContent.')
      const rejected = await rejectPlan(dir, 'doomed-plan')
      assert.ok(rejected)
      assert.equal(checked(rejected).status, 'rejected')
      // File is kept on disk so the agent can revise it in place.
      const reread = await readPlan(dir, 'doomed-plan')
      assert.ok(reread)
      assert.equal(checked(reread).status, 'rejected')
    } finally {
      cleanup()
    }
  })

  it('rejectPlan returns null for non-existent plan', async () => {
    const { dir, cleanup } = setup()
    try {
      assert.equal(await rejectPlan(dir, 'ghost'), null)
    } finally {
      cleanup()
    }
  })

  it('deletePlan removes file', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'temp-plan', '# Temp')
      assert.ok(await deletePlan(dir, 'temp-plan'))
      const plan = await readPlan(dir, 'temp-plan')
      assert.equal(plan, null)
    } finally {
      cleanup()
    }
  })

  it('readPlan returns null for non-existent plan', async () => {
    const { dir, cleanup } = setup()
    try {
      const plan = await readPlan(dir, 'nonexistent')
      assert.equal(plan, null)
    } finally {
      cleanup()
    }
  })

  it('listPlans returns empty for no plans', async () => {
    const { dir, cleanup } = setup()
    try {
      const plans = await listPlans(dir)
      assert.deepEqual(plans, [])
    } finally {
      cleanup()
    }
  })

  it('plan status is parsed from content markers', async () => {
    const { dir, cleanup } = setup()
    try {
      await writePlan(dir, 'exec-plan', '> **Status: EXECUTED** — 2026-01-01\n\n# Exec')
      const plan = await readPlan(dir, 'exec-plan')
      assert.equal(checked(plan).status, 'executed')
    } finally {
      cleanup()
    }
  })
})
