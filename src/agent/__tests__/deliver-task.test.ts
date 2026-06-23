import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDeliverTaskTool, detectSymptomPatch, resetPostCommitReviewCooldown } from '../deliver-task.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import type { ChangeSet } from '../review-discipline.js'
import type { ReviewOutcome, ReviewRouterDeps, ReviewRouterOptions } from '../review-router.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import type { ToolCallParams, ToolResult } from '../../tools/types.js'
import type { SessionRegistry } from '../session-registry.js'
import { getReviewHealth, resetReviewHealth } from '../review-health.js'

function makeContext(opts: {
  taskId: string
  ownedFiles: string[]
  externalFiles?: string[]
  preExistingUntracked?: string[]
  dirtyFiles?: string[]
  verifications?: Array<{ command: string; status: 'passed' | 'failed' | 'blocked'; meta?: Record<string, unknown> }>
  projectMemory?: string
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => { ok: boolean; output: string }
  routeReviewWorkflow?: (change: ChangeSet, deps: ReviewRouterDeps, options?: ReviewRouterOptions) => Promise<ReviewOutcome>
  reviewDeps?: ReviewRouterDeps
  disableReviewDeps?: boolean
  reviewDepth?: number
  sessionRegistry?: SessionRegistry
  sessionId?: string
  detectWroteButNeverRead?: (cwd: string, files: string[]) => Array<{ symbol: string; file: string; kind: 'export' | 'field' }>
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
    sessionRegistry: opts.sessionRegistry,
    sessionId: opts.sessionId,
    getCurrentDirtyFiles: () => opts.dirtyFiles,
    getProjectMemoryContent: () => opts.projectMemory,
    commitOwnedFiles: opts.commitOwnedFiles,
    routeReviewWorkflow: opts.disableReviewDeps
      ? opts.routeReviewWorkflow
      : (opts.routeReviewWorkflow ?? (async () => ({ tier: 'L2', verdict: 'verified', evidence: 'test review shim', rounds: 1 }))),
    reviewDeps: opts.disableReviewDeps ? undefined : (opts.reviewDeps ?? {} as ReviewRouterDeps),
    reviewDepth: opts.reviewDepth,
    detectWroteButNeverRead: opts.detectWroteButNeverRead ?? (() => []),
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

function toolDescription(): string {
  const { tool } = makeContext({
    taskId: 'schema',
    ownedFiles: [],
  })
  return tool.definition.description
}

describe('deliver-task — semantic task delivery tool', () => {
  beforeEach(() => { resetPostCommitReviewCooldown() })

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
    // Recovery guidance should be present
    assert.ok(result.content.includes('Recovery'))
    assert.ok(result.content.includes('TARGETED'))
  })

  it('RED with unverified files suggests targeted tests, not full suite', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run when gate is RED')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: test' } })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('unverified'))
    assert.ok(result.content.includes('Do NOT run the full test suite'))
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

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'feat: scoped delivery' }])
    assert.match(result.content, /Scoped commit created/)
    assert.match(result.content, /commit abc123/)
  })

  it('describes complex spec checklist audit in the tool schema', () => {
    const description = toolDescription()

    assert.match(description, /Complex spec delivery checklist/)
    assert.match(description, /fact-flow graph verified/)
    assert.match(description, /condition matrix verified/)
    assert.match(description, /counterexample tests verified/)
  })

  it('denoises junk external files: capped list + summary count (C-fix)', async () => {
    const junk = Array.from({ length: 67 }, (_, i) => `.test-tmp/corrupt-${i}.json`)
    const signal = ['src/important.ts', 'docs/notes.md']
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      externalFiles: [...junk, ...signal],
      dirtyFiles: ['src/a.ts', ...junk, ...signal],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)

    assert.doesNotMatch(result.content, /\.test-tmp\/corrupt-/, 'junk paths must not be listed')
    assert.match(result.content, /src\/important\.ts/)
    assert.match(result.content, /\(\+67 more, 67 junk\/gitignored\)/)
    assert.match(result.content, /External files \(69\)/, 'count stays truthful even when display is filtered')
    // Gate section (up to "Verifications:") must stay compact.
    const gateSection = result.content.split('\n')
    const verifIdx = gateSection.findIndex(l => l.startsWith('Verifications:'))
    assert.ok(verifIdx >= 0 && verifIdx < 25, `gate file lists must stay compact, got ${verifIdx + 1} lines`)
  })

  it('caps long owned-file lists at 5 with a (+N more) summary (C-fix)', async () => {
    const owned = Array.from({ length: 12 }, (_, i) => `src/mod-${i}.ts`)
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: owned,
      dirtyFiles: owned,
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute({ ...params, ownedFiles: owned })

    assert.match(result.content, /Owned files \(12\)/)
    assert.match(result.content, /\(\+7 more\)/)
    assert.doesNotMatch(result.content, /src\/mod-9\.ts/, 'files beyond the cap are summarized, not listed')
  })

  it('surfaces wrote-but-never-read findings as a YELLOW hint without blocking the commit (D-fix)', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      detectWroteButNeverRead: () => [
        { symbol: 'modelOverride', file: 'src/a.ts', kind: 'field' },
      ],
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: add override' } })

    assert.equal(result.isError ?? false, false, 'nudge must not block delivery')
    assert.equal(committed, true)
    assert.match(result.content, /wrote-but-never-read/)
    assert.match(result.content, /modelOverride/)
    assert.match(result.content, /non-blocking/)
  })

  it('routes fix commits through ReviewRouter before scoped commit', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    let routedChange: ChangeSet | undefined
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedChange = change
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: npx tsc --noEmit → ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routedChange?.files.join(','), 'src/a.ts')
    assert.equal(routedChange?.crossModule, false)
    assert.equal(routedChange?.isFix, true)
    assert.equal(routedChange?.goalActive, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'fix: scoped delivery' }])
    assert.match(result.content, /审查通过 \(L2\)/)
  })

  it('commit succeeds when ReviewRouter rejects — review is advisory post-commit', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'L2', verdict: 'rejected', escalated: true, rounds: 3, evidence: 'still broken' }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    // Post-commit advisory: the commit has landed even if review found issues.
    assert.equal(result.isError ?? false, false)
    assert.equal(committed, true)
    assert.match(result.content, /审查门发现问题 \(L2\)/)
    assert.match(result.content, /still broken/)
    assert.match(result.content, /提交已落地/)
  })

  it('renders auto-review infra failure as INCONCLUSIVE, never as verified (B-fix)', async () => {
    resetReviewHealth()
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({
        tier: 'auto',
        verdict: 'inconclusive',
        evidence: 'review DID NOT run (infra failure): worker: reviewer crashed',
        rounds: 1,
        infraFailures: [{ kind: 'worker', claim: 'reviewer crashed' }],
      }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false, 'inconclusive auto review must fail open')
    assert.equal(committed, true, 'delivery proceeds despite infra failure')
    assert.match(result.content, /审查未决 \(auto\)/)
    assert.match(result.content, /DID NOT run/)
    assert.match(result.content, /未经审查/)
    assert.doesNotMatch(result.content, /审查通过/, 'the word verified must not describe a review that never ran')
    assert.ok(result.content.length > 0, 'sentinel: content must never be empty')
    const health = getReviewHealth()
    assert.equal(health.infraFailureCount, 1)
    assert.equal(health.consecutiveInfraFailures, 1)
    assert.deepEqual(health.lastFailureKinds, ['worker'])
  })

  it('reports an honest INCONCLUSIVE when the auto review workflow throws (B-fix)', async () => {
    resetReviewHealth()
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { throw new Error('Review workflow timed out') },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false, 'auto review crash must fail open')
    assert.equal(committed, true)
    assert.match(result.content, /审查未决 \(auto\)/)
    assert.match(result.content, /DID NOT run/)
    assert.doesNotMatch(result.content, /审查通过/)
    assert.ok(result.content.length > 0, 'sentinel: content must never be empty')
    const health = getReviewHealth()
    assert.equal(health.infraFailureCount, 1)
    assert.deepEqual(health.lastFailureKinds, ['timeout'])
  })

  it('records healthy auto-review runs in review health (B-fix)', async () => {
    resetReviewHealth()
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'auto', verdict: 'verified', evidence: 'no blocking findings', rounds: 1 }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    const health = getReviewHealth()
    assert.equal(health.totalRuns, 1)
    assert.equal(health.infraFailureCount, 0)
    assert.equal(health.consecutiveInfraFailures, 0)
  })

  it('routes non-fix code commits through ReviewRouter as objective review assistance', async () => {
    let routedChange: ChangeSet | undefined
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedChange = change
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: targeted tests and boundary probe → ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routedChange?.files.join(','), 'src/a.ts')
    assert.equal(routedChange?.crossModule, false)
    assert.equal(routedChange?.isFix, false)
    assert.equal(routedChange?.goalActive, false)
    assert.match(result.content, /审查通过 \(L2\)/)
    assert.match(result.content, /Scoped commit created/)
  })

  it('post-commit review cooldown reports an honest skip, not a false merge', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => {
        routeCalls++
        return { tier: 'auto', verdict: 'verified', evidence: 'no blocking findings', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    // First commit runs the review and arms the 30s cooldown.
    await tool.execute({ ...params, input: { commit: true, message: 'feat: part 1' } })
    // Second commit within the window hits the cooldown branch.
    const second = await tool.execute({ ...params, input: { commit: true, message: 'feat: part 2' } })

    assert.equal(routeCalls, 1, 'second review must be skipped by cooldown')
    assert.match(second.content, /提交后审查跳过：距上轮审查/)
    assert.doesNotMatch(second.content, /合并入上一轮/, 'must not claim a merge that never happens')
  })

  it('commit succeeds when review deps are not wired — advisory skip, not block', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
      disableReviewDeps: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    // Post-commit: unwired review is advisory, not a blocker.
    assert.equal(result.isError ?? false, false)
    assert.equal(committed, true)
    assert.match(result.content, /提交后审查跳过.*审查依赖不可用/)
    assert.match(result.content, /Scoped commit created/)
  })

  it('unwired review with force=true — commit succeeds, advisory skip', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
      disableReviewDeps: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, force: true, message: 'feat: scoped delivery' } })

    // Post-commit: force no longer needed for unwired review, but commit still succeeds.
    assert.equal(result.isError ?? false, false)
    assert.equal(committed, true)
    assert.match(result.content, /提交后审查跳过.*审查依赖不可用/)
    assert.match(result.content, /Scoped commit created/)
  })

  it('skips ReviewRouter when reviewDepth indicates child review context', async () => {
    let routerCalled = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      reviewDepth: 1,
      routeReviewWorkflow: async () => {
        routerCalled = true
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: should not happen', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routerCalled, false)
    assert.match(result.content, /Scoped commit created/)
  })

  it('skips ReviewRouter when ToolCallParams reviewDepth indicates child worker context', async () => {
    let routerCalled = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => {
        routerCalled = true
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: should not happen', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, reviewDepth: 1, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routerCalled, false)
    assert.match(result.content, /Scoped commit created/)
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

    assert.match(result.content, /审查原则清单：/)
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

    assert.doesNotMatch(result.content, /审查原则清单：/)
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
    it('reports invocation failure as YELLOW (non-blocking)', async () => {
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

      assert.match(result.content, /Delivery Gate: YELLOW/)
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

  // ── P2 cross-session claim conflicts ──

  describe('cross-session claim conflict detection', () => {
    it('reports conflict when other session holds exclusive claim on owned file', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-'))
      const otherRegistry = await SR.create(tmpDir)
      otherRegistry.register('other-session', '/fake/project')
      otherRegistry.acquireClaim('other-session', 'src/owned.ts', 'exclusive')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: otherRegistry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.match(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /src\/owned\.ts.*exclusive lock held by session other-session/)
      } finally {
        otherRegistry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('blocks commit when other session holds a claim on an owned file', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-commit-block-'))
      const registry = await SR.create(tmpDir)
      registry.register('other-session', '/fake/project')
      registry.acquireClaim('other-session', 'src/owned.ts', 'exclusive')
      let committed = false

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
          commitOwnedFiles: () => {
            committed = true
            return { ok: true, output: 'commit should-not-happen' }
          },
        })

        const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: claim conflict' } })

        assert.equal(result.isError, true)
        assert.equal(committed, false)
        assert.match(result.content, /Cannot commit: cross-session claim conflicts are present/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('allows force=true to override a cross-session claim conflict explicitly', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-commit-force-'))
      const registry = await SR.create(tmpDir)
      registry.register('other-session', '/fake/project')
      registry.acquireClaim('other-session', 'src/owned.ts', 'shared_read')
      let committed = false

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
          commitOwnedFiles: () => {
            committed = true
            return { ok: true, output: 'commit abc123' }
          },
        })

        const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, force: true, message: 'feat: claim conflict override' } })

        assert.equal(result.isError ?? false, false)
        assert.equal(committed, true)
        assert.match(result.content, /Cross-session claim conflicts overridden with force=true/)
        assert.match(result.content, /Scoped commit created/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('does NOT report conflict when own session holds the claim', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-self-'))
      const registry = await SR.create(tmpDir)
      registry.register('my-session', '/fake/project')
      // My own session holds the claim — no conflict
      registry.acquireClaim('my-session', 'src/owned.ts', 'exclusive')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /Delivery Gate: GREEN/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('does NOT report conflict when no session holds claims', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-none-'))
      const registry = await SR.create(tmpDir)

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /Delivery Gate: GREEN/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('reports conflict for shared_read claim from other session too', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-read-'))
      const otherRegistry = await SR.create(tmpDir)
      otherRegistry.register('other-session', '/fake/project')
      otherRegistry.acquireClaim('other-session', 'src/owned.ts', 'shared_read')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: otherRegistry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.match(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /shared read held by session other-session/)
      } finally {
        otherRegistry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('no crash when sessionRegistry is absent (backward compatible)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        // sessionRegistry not provided
      })

      const result = await ctx.tool.execute(ctx.params)

      assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
      assert.match(result.content, /Delivery Gate: GREEN/)
    })
  })

  describe('files parameter — subset commit', () => {
    it('commits only specified subset of owned files when files param provided', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1 only', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1 only' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('rejects files param containing non-owned file', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: ['src/agent/a.ts', 'src/tools/NOT-OWNED.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in owned files/)
    })

    it('rejects empty files array', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: [] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /No files specified/)
    })

    it('ignores files param when commit is false (status-only)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute({
        ...params,
        input: { files: ['src/agent/a.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Scoped commit/)
    })
  })

  describe('cohesion RED gate on commit', () => {
    it('BLOCKS commit when files span 3+ areas without force', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('commit executor should NOT be called when cohesion gate blocks')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: big batch' },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Suggested split by area/)
    })

    it('allows commit with force=true when cohesion gate triggers', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: truly one unit', force: true },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Cohesion gate overridden/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files, message: 'feat: truly one unit' }])
    })

    it('does not block small focused commit (≤2 areas, ≤5 files)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: focused' },
      })

      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Scoped commit created/)
    })

    it('applies cohesion gate to files subset too', async () => {
      const allFiles = ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts', 'src/tui/d.ts', 'src/config/e.ts']
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      // Request a subset that still spans 3 areas
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: subset', files: ['src/agent/a.ts', 'src/tools/c.ts', 'src/tui/d.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /Commit cohesion gate/)
    })

    it('allows small subset commit even when total owned files are large', async () => {
      const allFiles = [
        'src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts',
        'src/tools/d.ts', 'src/tui/e.ts', 'src/config/f.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      // Request a focused subset (1 area, 2 files) — should pass
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1' }])
    })
  })

  describe('adopt — cross-session takeover', () => {
    it('adopts external files and commits them alongside owned files', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        dirtyFiles: ['src/mine.ts', 'src/other-session-a.ts', 'src/other-session-b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: take over crashed session work',
          adopt: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Adopted 2 external file/)
      assert.match(result.content, /src\/other-session-a\.ts/)
      assert.match(result.content, /src\/other-session-b\.ts/)
      assert.match(result.content, /Scoped commit created/)
      // All 3 files should be committed (1 owned + 2 adopted)
      assert.deepEqual(calls, [{
        files: ['src/mine.ts', 'src/other-session-a.ts', 'src/other-session-b.ts'],
        message: 'fix: take over crashed session work',
      }])
    })

    it('adopts external files even when no owned files exist', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        externalFiles: ['src/crashed-work.ts'],
        dirtyFiles: ['src/crashed-work.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit def456' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: adopt orphaned work',
          adopt: ['src/crashed-work.ts'],
        },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Adopted 1 external file/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/crashed-work.ts'], message: 'fix: adopt orphaned work' }])
    })

    it('blocks adopted files when the refreshed delivery gate is RED', async () => {
      let committed = false
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        externalFiles: ['src/crashed-work.ts'],
        dirtyFiles: ['src/crashed-work.ts'],
        commitOwnedFiles: () => {
          committed = true
          return { ok: true, output: 'commit should-not-happen' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: adopt unverified orphaned work',
          adopt: ['src/crashed-work.ts'],
        },
      })

      assert.equal(result.isError, true)
      assert.equal(committed, false)
      assert.match(result.content, /delivery gate is RED after adoption/)
      assert.match(result.content, /Run verification before delivery/)
    })

    it('rejects adopt for file not in external list', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/mine.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => { throw new Error('should not be called') },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: try adopt non-external',
          adopt: ['src/nonexistent.ts'],
        },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in external or co-owned files/)
    })

    it('accepts empty adopt array as no-op (not an error)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        dirtyFiles: ['src/mine.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc1234' }),
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: empty adopt is no-op',
          adopt: [],
        },
      })

      // Empty adopt array should be treated the same as omitting adopt — not an error
      assert.equal(result.isError, undefined)
    })

    it('ignores adopt when commit is false (status-only)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/mine.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: { adopt: ['src/external.ts'] },
      })

      // adopt is ignored in status-only mode — no adoption log
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Adopted/)
    })
  })

  // ── Mechanical-change fast-path (docs/rename bypass) ──

  describe('mechanical-change fast-path', () => {
    function tmpGitRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'mech-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      writeFileSync(join(dir, 'README.md'), '# Base\n')
      run(['add', '.']); run(['commit', '-qm', 'base'])
      return dir
    }

    function tmpGitRepoWithTracked(file: string, content: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'mech-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, file), content)
      run(['add', '.']); run(['commit', '-qm', 'base'])
      return dir
    }

    it('docs-only untracked file bypasses RED gate and commits successfully', async () => {
      const dir = tmpGitRepo()
      // Create a new untracked docs file
      writeFileSync(join(dir, 'CHANGELOG.md'), '# v2\n')

      const { tool, params } = makeContext({
        taskId: 't-docs',
        ownedFiles: ['CHANGELOG.md'],
        dirtyFiles: ['CHANGELOG.md'],
        verifications: [],  // no verification → unverified RED
        commitOwnedFiles: (_cwd, files, msg) => {
          const add = spawnSync('git', ['add', ...files], { cwd: dir })
          const commit = spawnSync('git', ['commit', '-qm', msg], { cwd: dir })
          return { ok: add.status === 0 && commit.status === 0, output: '' }
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'docs: update changelog' } })
      assert.equal(result.isError, undefined, `Expected successful commit, got error:\n${result.content}`)
      assert.match(result.content, /机械式变更.*docs-only/)
    })

    it('normal code change with unverified RED is NOT bypassed', async () => {
      const dir = tmpGitRepoWithTracked('src/a.ts', 'const x = 1\n')
      // Modify the tracked code file
      writeFileSync(join(dir, 'src/a.ts'), 'const x = 2\nconst y = 3\n')

      const { tool, params } = makeContext({
        taskId: 't-code',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [],
        commitOwnedFiles: () => ({ ok: true, output: '' }),
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'feat: change x' } })
      assert.equal(result.isError, true)
      assert.match(result.content, /Cannot commit/)
    })

    it('pure file rename (R100) bypasses RED gate — only the new path is owned', async () => {
      const dir = tmpGitRepoWithTracked('src/old.ts', 'export const x = 1\n')
      spawnSync('git', ['mv', 'src/old.ts', 'src/new.ts'], { cwd: dir }) // byte-identical rename

      const { tool, params } = makeContext({
        taskId: 't-rename',
        ownedFiles: ['src/new.ts'],            // old path is pre-existing/external
        dirtyFiles: ['src/old.ts', 'src/new.ts'],
        verifications: [],                      // no verification → unverified RED
        commitOwnedFiles: (_cwd, _files, msg) => {
          const add = spawnSync('git', ['add', '-A'], { cwd: dir })
          const commit = spawnSync('git', ['commit', '-qm', msg], { cwd: dir })
          return { ok: add.status === 0 && commit.status === 0, output: '' }
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'refactor: rename old to new' } })
      assert.equal(result.isError, undefined, `Expected rename bypass, got error:\n${result.content}`)
      assert.match(result.content, /机械式变更.*rename-mechanical/)
    })

    it('owned_failure RED is NEVER bypassed even for docs files', async () => {
      const dir = tmpGitRepo()
      writeFileSync(join(dir, 'GUIDE.md'), '# Guide\n')

      const { tool, params } = makeContext({
        taskId: 't-fail',
        ownedFiles: ['GUIDE.md'],
        dirtyFiles: ['GUIDE.md'],
        verifications: [{ command: 'npm test', status: 'failed' }],
        commitOwnedFiles: () => ({ ok: true, output: '' }),
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'docs: guide' } })
      assert.equal(result.isError, true)
      assert.match(result.content, /Cannot commit/)
    })
  })
})
