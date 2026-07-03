import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writePlan, readPlan, listPlans, approvePlan, rejectPlan, deletePlan, slugify, stripPlanStatusMarkers, resolvePlanOptionLabel } from '../plan-store.js'
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

  // 2026-07-03 缺陷复盘: markPlanStatus 回写时未透传 options,
  // 批准/驳回会把多方案 frontmatter 永久抹掉,导致 selectedApproach 校验形同虚设。
  it('approvePlan preserves options frontmatter', async () => {
    const { dir, cleanup } = setup()
    try {
      const options = [
        { label: 'A (Recommended)', description: 'fast' },
        { label: 'B', description: 'safe' },
      ]
      await writePlan(dir, 'multi', '# Multi\n\nBody.', options)
      const approved = await approvePlan(dir, 'multi')
      assert.deepEqual(checked(approved).options, options)
      const reread = await readPlan(dir, 'multi')
      assert.deepEqual(checked(reread).options, options)
      assert.equal(checked(reread).status, 'approved')
    } finally {
      cleanup()
    }
  })

  it('rejectPlan preserves options frontmatter', async () => {
    const { dir, cleanup } = setup()
    try {
      const options = [{ label: 'X', description: 'only' }, { label: 'Y', description: 'alt' }]
      await writePlan(dir, 'multi-rej', '# Multi\n\nBody.', options)
      const rejected = await rejectPlan(dir, 'multi-rej')
      assert.deepEqual(checked(rejected).options, options)
    } finally {
      cleanup()
    }
  })
})

describe('stripPlanStatusMarkers', () => {
  it('removes approve/reject status lines so resubmission is not stuck rejected', () => {
    const content = '> **Status: REJECTED** — 2026-07-03T00:00:00.000Z\n\n# Plan\n\nrevised body\n'
    const stripped = stripPlanStatusMarkers(content)
    assert.ok(!stripped.includes('Status: REJECTED'))
    assert.ok(stripped.startsWith('# Plan'))
  })

  it('removes stacked markers from repeated approve/reject cycles', () => {
    const content =
      '> **Status: REJECTED** — 2026-07-01\n\n> **Status: APPROVED** — 2026-07-02\n\n# Plan\n\nbody\n'
    const stripped = stripPlanStatusMarkers(content)
    assert.ok(!stripped.includes('Status:'))
    assert.ok(stripped.startsWith('# Plan'))
  })

  it('leaves regular blockquotes untouched', () => {
    const content = '# Plan\n\n> **Note:** this is a design note\n'
    assert.equal(stripPlanStatusMarkers(content), content)
  })
})

describe('resolvePlanOptionLabel', () => {
  const options = [
    { label: 'Big Bang (Recommended)', description: 'all at once' },
    { label: 'Incremental', description: 'step by step' },
  ]

  it('matches exact label', () => {
    assert.equal(resolvePlanOptionLabel(options, 'Incremental'), 'Incremental')
  })

  it('matches case-insensitively and returns canonical label', () => {
    assert.equal(resolvePlanOptionLabel(options, 'incremental'), 'Incremental')
  })

  it('tolerates omitting the (Recommended) suffix', () => {
    assert.equal(resolvePlanOptionLabel(options, 'big bang'), 'Big Bang (Recommended)')
  })

  it('returns undefined for unknown labels', () => {
    assert.equal(resolvePlanOptionLabel(options, 'YOLO'), undefined)
  })

  it('returns undefined when a bare label is ambiguous', () => {
    const ambiguous = [
      { label: 'Fast (v1)', description: 'a' },
      { label: 'Fast (v2)', description: 'b' },
    ]
    assert.equal(resolvePlanOptionLabel(ambiguous, 'fast'), undefined)
  })
})
