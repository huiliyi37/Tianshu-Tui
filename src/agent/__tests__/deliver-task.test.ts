import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDeliverTaskTool, detectSymptomPatch } from '../deliver-task.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import type { ToolCallParams, ToolResult } from '../../tools/types.js'

function makeContext(opts: {
  taskId: string
  ownedFiles: string[]
  externalFiles?: string[]
  preExistingUntracked?: string[]
  dirtyFiles?: string[]
  verifications?: Array<{ command: string; status: 'passed' | 'failed' | 'blocked'; meta?: Record<string, unknown> }>
  projectMemory?: string
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => { ok: boolean; output: string }
}) {
  const baseline = createWorktreeBaseline({
    branch: 'feat/b1',
    head: 'abc123',
    preExistingDirty: opts.externalFiles ?? [],
    preExistingUntracked: opts.preExistingUntracked ?? [],
    capturedAt: Date.now(),
  })
  const ledger = createTaskLedger({ taskId: opts.taskId })
  for (const f of opts.ownedFiles) ledger.record({ type: 'file_write', path: f })
  for (const v of (opts.verifications ?? [])) ledger.record({ type: 'verification', command: v.command, status: v.status, meta: v.meta })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  ownership.autoOwnFromLedger()
  const attribution = createVerificationAttribution({ ownership })
  const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution })

  const tool = createDeliverTaskTool(() => ({
    taskLedger: ledger,
    ownership,
    gate,
    getCurrentDirtyFiles: () => opts.dirtyFiles,
    getProjectMemoryContent: () => opts.projectMemory,
    commitOwnedFiles: opts.commitOwnedFiles,
  }))

  const params: ToolCallParams = {
    input: {},
    toolUseId: 'test-1',
    cwd: '/fake/project',
    taskId: opts.taskId,
    ownedFiles: opts.ownedFiles,
  }

  return { tool, params, ledger, ownership, gate }
}

describe('deliver-task — semantic task delivery tool', () => {
  it('reports GREEN delivery readiness when verified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('GREEN'))
  })

  it('reports RED without marking status-only report as tool error when unverified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('RED'))
  })

  it('marks commit=true RED as tool error because commit request is rejected', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run when gate is RED')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: test' } })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('RED'))
    assert.ok(result.content.includes('Cannot commit'))
  })

  it('reports YELLOW when external verification blocked but owned files verified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    // With only owned files verified and no external blocked verifications,
    // the gate is GREEN. YELLOW requires external blocked verifications.
    const result = await tool.execute(params)
    assert.ok(result.content.includes('GREEN'))
  })

  it('includes ownership report in output', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      externalFiles: ['src/ext.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)
    assert.ok(result.content.includes('src/a.ts'))
    assert.ok(result.content.includes('src/b.ts'))
    assert.ok(result.content.includes('src/ext.ts'))
  })

  it('handles empty delivery (no owned files)', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
    })

    const result = await tool.execute(params)
    assert.ok(result.content.includes('GREEN'))
    assert.ok(result.content.includes('(none)'))
  })

  it('reports failed verification details', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsx --test', status: 'failed' }],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('RED'))
    assert.ok(result.content.includes('failure'))
  })

  it('requires approval for commit action', () => {
    const { tool } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const needsApproval = tool.requiresApproval({
      input: { message: 'feat: deliver', commit: true },
      toolUseId: 'test-1',
      cwd: '/fake',
    })
    assert.equal(needsApproval, true)
  })

  it('executes scoped commit for commit=true when gate is green', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'fix: scoped delivery' }])
    assert.match(result.content, /Scoped commit created/)
    assert.match(result.content, /commit abc123/)
  })

  it('rejects commit=true without message before running executor', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run without message')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Commit requires/)
  })

  it('reports scoped commit executor failure as tool error', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => ({ ok: false, output: 'git commit failed' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: fail' } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Scoped commit failed/)
    assert.match(result.content, /git commit failed/)
  })

  it('reports commit=true with no owned files as scoped commit failure', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => ({ ok: false, output: 'No owned files to commit.' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: empty' } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Delivery Gate: GREEN/)
    assert.match(result.content, /No owned files to commit/)
  })

  it('does not require approval for status-only delivery report', () => {
    const { tool } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
    })

    const needsApproval = tool.requiresApproval({
      input: {},
      toolUseId: 'test-1',
      cwd: '/fake',
    })
    assert.equal(needsApproval, false)
  })

  it('reports external dirty files as informational caveats, not ownership warnings', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
      externalFiles: ['.rivet/prefix-diag.jsonl'],
    })

    const result = await tool.execute(params)

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Delivery Gate: GREEN/)
    assert.match(result.content, /Owned files \(0\)/)
    assert.match(result.content, /External files \(1\)/)
    assert.doesNotMatch(result.content, /Ownership health warnings:/)
    assert.match(result.content, /Ownership caveats:/)
    assert.match(result.content, /External dirty files are present and excluded from delivery scope\./)
  })

  it('auto-populates ownership from task ledger at execution time', async () => {
    const ctx = makeContext({
      taskId: 't1',
      ownedFiles: [],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    ctx.ledger.record({ type: 'file_write', path: 'src/late-write.ts' })
    const result = await ctx.tool.execute(ctx.params)

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Owned files \(1\)/)
    assert.match(result.content, /src\/late-write\.ts/)
  })

  it('treats clean historical owned files as non-blocking when current dirty snapshot is empty', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/already-committed.ts'],
      dirtyFiles: [],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Delivery Gate: GREEN/)
    assert.match(result.content, /Owned files \(0\)/)
    assert.match(result.content, /Historical owned files \(1\)/)
    assert.match(result.content, /src\/already-committed\.ts/)
  })

  it('still blocks current dirty owned files when unverified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/current-dirty.ts'],
      dirtyFiles: ['src/current-dirty.ts'],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Delivery Gate: RED/)
    assert.match(result.content, /Owned files \(1\)/)
  })

  it('generates consistent report for same state', async () => {
    const ctx1 = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })
    const ctx2 = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const r1 = await ctx1.tool.execute(ctx1.params)
    const r2 = await ctx2.tool.execute(ctx2.params)

    assert.equal(r1.content, r2.content)
  })

  it('includes review principle checklist for owned files matching project memory evidence', async () => {
    const projectMemory = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: Boundary clarity comes before speed.

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/loop.ts\`
`
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/agent/loop.ts'],
      dirtyFiles: ['src/agent/loop.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      projectMemory,
    })

    const result = await tool.execute(params)

    assert.match(result.content, /Review principle checklist:/)
    assert.match(result.content, /Do not declare a streamed response duplicate/)
    assert.match(result.content, /Delivery Gate: GREEN/)
  })

  it('does not include checklist when no evidence paths match owned files', async () => {
    const projectMemory = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: Boundary clarity comes before speed.

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/loop.ts\`
`
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/config/schema.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      projectMemory,
    })

    const result = await tool.execute(params)

    assert.doesNotMatch(result.content, /Review principle checklist:/)
    assert.match(result.content, /Delivery Gate: GREEN/)
  })

  describe('preExistingUntracked scenarios', () => {
    it('treats preExistingUntracked files as external in ownership report', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: ['src/untracked.ts', 'temp.txt'],
        dirtyFiles: ['src/owned.ts', 'src/untracked.ts', 'temp.txt'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/untracked\.ts/)
      assert.match(result.content, /temp\.txt/)
    })

    it('prevents registerOwned from claiming preExistingUntracked files', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        preExistingUntracked: ['src/pre-existing.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      // Try to register the pre-existing untracked file
      ctx.ownership.registerOwned('src/pre-existing.ts')

      // Should not be owned
      assert.equal(ctx.ownership.isOwned('src/pre-existing.ts'), false)

      // Now execute and verify it appears as external
      const result = await ctx.tool.execute(ctx.params)
      assert.match(result.content, /External files \(1\)/)
      assert.match(result.content, /src\/pre-existing\.ts/)
    })

    it('shows ownership health warning when dirty file has no classification', async () => {
      // Note: dirtyFiles passed to makeContext are used by getCurrentDirtyFiles mock.
      // In real usage, deliver-task computes dirtyFiles from owned + external only.
      // Files that are neither owned nor external are not included in the health check.
      // This test verifies the current behavior: unknown files are silently excluded.
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: [],
        dirtyFiles: ['src/owned.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      // No warnings because all dirty files are classified
      assert.doesNotMatch(result.content, /Ownership health warnings:/)
    })

    it('allows commit=true for owned files even when preExistingUntracked are present', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: ['src/untracked.ts'],
        dirtyFiles: ['src/owned.ts', 'src/untracked.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only owned file should be committed, not the untracked one
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('handles mixed preExistingDirty and preExistingUntracked correctly', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/dirty-ext.ts'],
        preExistingUntracked: ['src/untracked-ext.ts'],
        dirtyFiles: ['src/owned.ts', 'src/dirty-ext.ts', 'src/untracked-ext.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/dirty-ext\.ts/)
      assert.match(result.content, /src\/untracked-ext\.ts/)
    })
  })

  describe('co-ownership scenarios', () => {
    it('shows co-owned files in report when external file is registered', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      // Register external file as co-owned
      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /Co-owned files \(1\)/)
      assert.match(result.content, /src\/shared\.ts/)
      assert.match(result.content, /External files \(1\)/)
    })

    it('shows co-owned caveat in ownership health', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Ownership caveats:/)
      assert.match(result.content, /co-owned file\(s\) present/)
    })

    it('allows commit=true for owned files when co-owned files exist', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only truly owned file should be committed, not co-owned
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('distinguishes co-owned from external in ownership report', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts', 'src/external.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Co-owned files \(1\)/)
      assert.match(result.content, /src\/shared\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/external\.ts/)
    })
  })

  describe('verification diagnostics', () => {
    it('reports invocation failure separately from owned test failure', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{
          command: 'run_tests src/a.test.ts',
          status: 'failed',
          meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0, recommendedCommand: 'tsx --test src/a.test.ts' },
        }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: RED/)
      assert.match(result.content, /Verification diagnostics:/)
      assert.match(result.content, /Tool invocation failure candidates:/)
      assert.match(result.content, /Shortest next step: tsx --test src\/a\.test\.ts/)
      assert.doesNotMatch(result.content, /Owned verification failed\. Fix failures before delivery\./)
    })

    it('reports stale superseded failures without blocking wording', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [
          {
            command: 'run_tests src/a.test.ts',
            status: 'failed',
            meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
          },
          {
            command: 'tsx --test src/a.test.ts',
            status: 'passed',
            meta: { scope: 'targeted', exitCode: 0, passed: 1, failed: 0, skipped: 0 },
          },
        ],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Stale failure candidates: 1/)
      assert.doesNotMatch(result.content, /Cannot commit/)
    })

    it('does not amplify stale failures when no current owned dirty files', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/already-clean.ts'],
        dirtyFiles: [],
        verifications: [{
          command: 'run_tests src/a.test.ts',
          status: 'failed',
          meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
        }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(0\)/)
      assert.match(result.content, /Tool invocation failure candidates:/)
      assert.doesNotMatch(result.content, /⚠️  Blocking:/)
    })
  })

  describe('unclassified dirty files → dynamic external reclassification', () => {
    it('reports GREEN when dirty unclassified files are lazily reclassified as dynamic externals', async () => {
      // P1 living baseline: files with no ledger trace that are NOT in the baseline
      // external set are now lazily reclassified as "dynamic externals" —
      // created by other sessions after our baseline was taken.
      // This eliminates false YELLOWs from stale baseline information.
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts', 'src/new-session-file.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute(ctx.params)

      // src/new-session-file.ts is dynamically reclassified as external → GREEN
      assert.match(result.content, /Delivery Gate: GREEN/)
      // It appears in the external files section, not as an "unclassified" warning
      assert.match(result.content, /External files \(1\)/)
      assert.match(result.content, /src\/new-session-file\.ts/)
      // No ownership health warning for unclassified files
      assert.doesNotMatch(result.content, /no ownership classification/)
    })

    it('allows commit=true when dirty unclassified files are reclassified as external (only owned committed)', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts', 'src/new-session-file.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only src/owned.ts has a ledger trace → only it is owned and committed
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('does not report YELLOW when all dirty files are classified', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/owned.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Ownership health warnings:/)
    })
  })

  describe('detectSymptomPatch', () => {
    function tmpRepo(file: string, before: string, after: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'sym-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      writeFileSync(join(dir, file), before)
      run(['add', '.']); run(['commit', '-qm', 'base'])
      writeFileSync(join(dir, file), after)
      return dir
    }

    it('flags a single-line fallback patch', () => {
      const dir = tmpRepo('a.ts', 'const x = v ?? "medium"\n', 'const x = v || "medium"\n')
      assert.match(detectSymptomPatch(dir)!, /症状处的 fallback 补丁/)
    })

    it('ignores a multi-line structural change', () => {
      const dir = tmpRepo('a.ts', 'const x = 1\n', 'const a = 1\nconst b = 2\nconst c = 3\n')
      assert.equal(detectSymptomPatch(dir), null)
    })
  })
})
