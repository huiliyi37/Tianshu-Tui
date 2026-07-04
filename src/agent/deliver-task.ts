/**
 * deliver_task — 语义化交付工具 (B1-8)
 *
 * 从低层 git commit 升级到语义化工程交付原语。
 *
 * 行为：
 * - 读取 TaskLedger + OwnershipLedger + DeliveryGate v2
 * - 如果 RED（owned failures / unverified），拒绝交付
 * - 如果 YELLOW（external blockers），说明但不阻塞
 * - 如果 GREEN，输出结构化交付报告
 *
 * 默认只输出交付门报告。
 * 当 commit=true 且 approval 通过时，会执行 ownership-scoped commit。
 *
 * HEARTH 兼容：交付报告可沉积为 cycle_close 的 durable evidence。
 * Songline 兼容：交付状态是 obligation fulfillment 信号，可沉积 pheromone。
 *
 * @module deliver-task
 * @task B1-8
 */

import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, isAbsolute } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { DeliveryGateV2 } from './delivery-gate-v2.js'
import { filterExternalNoise } from './delivery-gate-v2.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import { classifyChange, createGitDiffProvider, isMechanicalFastPathEnabled } from './change-classification.js'
import { commitScopedFiles, type ScopedCommitResult } from './scoped-git-commit.js'
import { buildReviewPrincipleChecklist } from './review-principle-checklist.js'
import { checkCommitCohesion } from './commit-cohesion.js'
import { isCrossModule, isFixContext, shouldRouteReviewWorkflow, GENERAL_DEV_DISCIPLINES, LARGE_FILE_WARN_THRESHOLD, type ChangeSet, type ReviewScale } from './review-discipline.js'
import { routeReviewWorkflow, reviewWorkflowBudgetMs, type ReviewRouterDeps, type ReviewOutcome, type ReviewMode } from './review-router.js'
import { isReviewDisciplineEnabled } from '../config/review-discipline-config.js'
import type { ReviewConfig } from '../config/schema.js'
import { recordAutoReviewRun } from './review-health.js'
import { detectWroteButNeverRead, formatWroteButNeverRead, detectReadButNeverProduced, formatReadButNeverProduced } from './wiring-nudge.js'
import { readUnacknowledged, acknowledgeAll, type RecoveryEntry } from './recovery-journal.js'
import { analyzeImpact } from '../repo/meridian-impact.js'
import { runChangedFilesTypecheckMemo, typecheckGateEnabled } from './typecheck-gate.js'
import { scanFilesForProbes, formatProbeHits, type ProbeHit } from './probe-detector.js'

export interface B1Context {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  gate: DeliveryGateV2
  /** Optional SessionRegistry for cross-session claim conflict detection */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current session ID for claim management */
  sessionId?: string
  /** Test hook / alternate runtime source for current dirty files. */
  getCurrentDirtyFiles?: (cwd: string) => string[] | undefined
  /** Test hook / alternate runtime source for project memory markdown. */
  getProjectMemoryContent?: (cwd: string) => string | undefined
  /** Test hook / alternate runtime executor for scoped commits. */
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => ScopedCommitResult
  /** Review router entry point. Defaults to routeReviewWorkflow when reviewDeps is provided. */
  routeReviewWorkflow?: typeof routeReviewWorkflow
  /** Dependencies used by the review router to spawn verifier/patcher/squadron workers. */
  reviewDeps?: ReviewRouterDeps
  /** Re-entrancy guard: child review contexts must not recursively trigger review routing. */
  reviewDepth?: number
  /** Task dependency depth — upgrades review scale for wiring/system tasks.
   *  Accept a getter so the value is resolved at review-time, not context-creation time. */
  getDepthLayer?: () => import('../context/task-contract.js').TaskDepthLayer | undefined
  /** Test hook for the wrote-but-never-read static check. */
  detectWroteButNeverRead?: typeof detectWroteButNeverRead
  /** Test hook for the read-but-never-produced (虚假绿灯) static check. */
  detectReadButNeverProduced?: typeof detectReadButNeverProduced
  /** VSW: current active snapshotRef. When provided, the gate drops verifications
   *  whose snapshotRef is stale (owned diff changed since they ran). Absent →
   *  no supersession (unchanged default). */
  getCurrentSnapshotRef?: () => string | undefined
  /** True when a goal tracker is actively driving auto-continuation.
   *  When active, post-commit auto-review is suppressed (L1 nudge-only)
   *  to prevent child review workers from stalling the goal loop. */
  isGoalActive?: () => boolean
  /** True when the goal tracker deactivated with reason='achieved'.
   *  Signals deliver_task to auto-upgrade the final commit review to L3. */
  isGoalAchieved?: () => boolean
  /** Last goal judge verdict stored on the tracker, for surfacing in the
   *  delivery report. Null when the judge hasn't run (e.g. judge disabled
   *  or goal completed before the judge had a chance to run). */
  getLastVerdict?: () => import('./goal-tracker.js').StoredGoalJudgeVerdict | null
  /** Review configuration snapshot (subset of agent.review). Used for per-config
   *  gating of auto review (review.skipAuto) without re-reading the full Config.
   *  Optional: absent → no-skip (preserves current behavior). */
  reviewConfig?: ReviewConfig
  /** Meridian indexer — when available, blast radius is injected into review
   *  focusHint so verifier/inspector know which downstream consumers to check. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  /** Injectable typecheck runner for the review-gate backstop. Absent → the
   *  real `tsc --noEmit` is used (covers worker/headless). Tests pass a mock. */
  typecheckRunner?: import('./typecheck-gate.js').TypecheckRunner
  /** Injectable probe scanner for the probe-residue gate. Absent → the real
   *  scanFilesForProbes with readFileSync is used. Tests pass a mock. */
  scanProbes?: (files: string[], cwd: string) => import('./probe-detector.js').ProbeHit[]
}

// ── Post-commit review batching ──
// When multiple deliver_task commits fire in quick succession (e.g. splitting
// a large changeset into area-scoped commits), each would trigger a separate
// review worker — wasteful when one review can cover the whole session's work.
// Cooldown: after a review launches, skip subsequent launches within this window.
const POST_COMMIT_REVIEW_COOLDOWN_MS = 30_000
let lastPostCommitReviewAt = 0

/** Test-only: reset the module-level cooldown so it does not leak across cases. */
export function resetPostCommitReviewCooldown(): void {
  lastPostCommitReviewAt = 0
}

function parseNulFileList(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

function readProjectMemory(cwd: string): string | undefined {
  try { return readFileSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8') } catch { return undefined }
}

/** Collect files exceeding the large-file threshold so review workers can avoid
 *  reading them in full (use offset/limit instead). Best-effort — stat failures
 *  are silently skipped. */
function collectLargeFiles(cwd: string, filePaths: readonly string[]): Array<{ path: string; sizeBytes: number }> | undefined {
  const large: Array<{ path: string; sizeBytes: number }> = []
  for (const p of filePaths) {
    try {
      const st = statSync(join(cwd, p))
      if (st.size >= LARGE_FILE_WARN_THRESHOLD) {
        large.push({ path: p, sizeBytes: st.size })
      }
    } catch { /* best-effort: missing / broken symlink / permission denied → skip */ }
  }
  return large.length > 0 ? large : undefined
}

function gitNameList(cwd: string, args: string[]): string[] | null {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (result.status !== 0) return null
  return parseNulFileList(result.stdout)
}

/**
 * Detect a "symptom-patch": a tiny single-file change touching only fallback
 * operators (`??` `||` default values). These are the shape of the trained-mode
 * reflex — patch the last hop, not the root. Returns a stance hint, or null.
 */
export function detectSymptomPatch(cwd: string): string | null {
  const res = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (res.status !== 0) return null
  const rows = res.stdout.split(/\r?\n/).filter(Boolean)
    .map(l => l.split('\t'))
    .filter(c => c.length === 3 && !(c[2] ?? '').includes('test'))
  if (rows.length !== 1) return null
  const row = rows[0]!
  const added = Number(row[0]) || 0
  if (added > 2) return null
  const patch = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', row[2]!], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (patch.status !== 0) return null
  const addedLines = patch.stdout.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++'))
  const fallbackOnly = addedLines.length > 0 && addedLines.every(l => /\?\?|\|\||=\s*['"`]?\w*['"`]?\s*$|fallback|default/.test(l))
  if (!fallbackOnly) return null
  return '⚖️  这是症状处的 fallback 补丁(单行、改默认值)。是源头修复还是就近打补丁？数据流追到源头了吗？(清醒锚点，不阻塞)'
}

export function collectCurrentDirtyFiles(cwd: string): string[] | undefined {
  const unstaged = gitNameList(cwd, ['diff', '--name-only', '-z'])
  const staged = gitNameList(cwd, ['diff', '--cached', '--name-only', '-z'])
  const untracked = gitNameList(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!unstaged || !staged || !untracked) return undefined

  const files = new Set<string>()
  for (const file of [...unstaged, ...staged, ...untracked]) {
    files.add(file)
  }
  return [...files].sort()
}

export function createDeliverTaskTool(getB1Context: (params?: ToolCallParams) => B1Context): Tool {
  return {
    definition: {
      name: 'deliver_task',
      description: `Check task delivery readiness using the B1 ownership and verification ledger.

### Usage
- Use deliver_task to check if the current task is ready to deliver/commit
- Reports GREEN (ready), YELLOW (ready with external caveats), or RED (blocked)
- Includes owned files, external files, and verification status
- By default, reports readiness without committing
- With commit=true, executes an ownership-scoped commit after approval

### Parameters
- commit: set to true to request approval for scoped commit (default: false)
- message: commit message (required if commit=true)
- files: optional array of owned file paths to commit (subset). When omitted, commits all owned files. Use this to commit logical units separately.
- adopt: array of external or co-owned file paths to claim ownership of before committing. Use when taking over work from a crashed/frozen session. Requires commit=true. The adopted files are force-added to the owned set and included in the commit scope.
- force: set to true to override the cohesion gate when committing many files across multiple areas. Use sparingly.

### Complex spec delivery checklist
For complex specs or cross-module integration, include checklist entries: fact-flow graph verified, condition matrix verified, counterexample tests verified.`,
      input_schema: {
        type: 'object',
        properties: {
          commit: { type: 'boolean', description: 'Request scoped commit of owned files' },
          message: { type: 'string', description: 'Commit message (required if commit=true)' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional subset of owned files to commit. When omitted, commits all owned files. Use this to split work into separate logical commits.',
          },
          adopt: {
            type: 'array',
            items: { type: 'string' },
            description: 'External file paths to adopt into owned set before committing. For cross-session takeover when another session crashed. Requires commit=true.',
          },
          force: {
            type: 'boolean',
            description: 'Override cohesion gate. Only use when the commit truly is one logical unit despite spanning multiple areas.',
          },
          checklist: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string' },
                done: { type: 'boolean' },
                files: { type: 'array', items: { type: 'string' } },
              },
              required: ['item', 'done'],
            },
            description: 'Task completion audit entries. For complex specs include fact-flow graph verified, condition matrix verified, and counterexample tests verified/deferred.',
          },
          review_level: {
            type: 'string',
            enum: ['L2', 'L3'],
            description: 'Explicitly set review workflow depth. L2 = single adversarial verifier. L3 = Review Squadron (5 inspectors). When omitted, review level is auto-classified from change structure (default: L1 nudge-only). Use this to manually trigger deeper review for high-risk or critical-path changes.',
          },
          skipAutoReview: {
            type: 'boolean',
            description: 'Suppress automatic post-commit review. Set automatically when a goal tracker is active (goal-driven auto-continuation). Set manually to bypass review for trivial or urgent changes.',
          },
        },
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const ctx = getB1Context(params)
      const reviewDepth = params.reviewDepth ?? ctx.reviewDepth ?? 0
      ctx.ownership.autoOwnFromLedger()
      const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? collectCurrentDirtyFiles(params.cwd)
      if (currentDirtyFiles) ctx.ownership.autoOwnFromBaseline(currentDirtyFiles)
      const report = ctx.gate.getReport([], currentDirtyFiles, ctx.getCurrentSnapshotRef?.())

      // C-fix (session 803d897d): cap file lists and filter external noise.
      // 67 untracked .test-tmp files used to drown the GREEN/YELLOW signal.
      const FILE_LIST_CAP = 5
      const renderFileList = (files: string[], extraHiddenCount = 0): string[] => {
        if (files.length === 0 && extraHiddenCount === 0) return ['  (none)']
        const shown = files.slice(0, FILE_LIST_CAP).map(f => `  ${f}`)
        const hidden = files.length - Math.min(files.length, FILE_LIST_CAP) + extraHiddenCount
        if (hidden > 0) shown.push(`  (+${hidden} more${extraHiddenCount > 0 ? `, ${extraHiddenCount} junk/gitignored` : ''})`)
        return shown
      }
      const externalSplit = filterExternalNoise(report.externalFiles, params.cwd)

      const lines: string[] = [
        `Delivery Gate: ${report.state}`,
        `Task: ${report.taskId}`,
        '',
        `Owned files (${report.ownedFileCount}):`,
        ...renderFileList(report.ownedFiles),
        '',
        `Co-owned files (${report.coOwnedFileCount}):`,
        ...renderFileList(report.coOwnedFiles),
        '',
        `Historical owned files (${report.historicalOwnedFileCount}):`,
        ...renderFileList(report.historicalOwnedFiles),
        '',
        `External files (${report.externalFileCount}):`,
        ...renderFileList(externalSplit.files, externalSplit.noiseCount),
        '',
        `Verifications: ${report.verificationCount}`,
      ]

      // 层 1a: echo latest verification totals so agents copy real numbers
      // into delivery reports instead of guessing from memory.
      if (report.latestVerificationTotals) {
        const v = report.latestVerificationTotals
        lines.push(`  Latest: ${v.passed} pass ${v.failed} fail ${v.skipped} skip — ${v.command}`)
      }

      const hasVerificationDiagnostics = report.currentBlockingFailure
        || report.supersededFailures > 0
      if (hasVerificationDiagnostics) {
        lines.push('')
        if (report.currentBlockingFailure) {
          lines.push(`  阻断项：${report.currentBlockingFailure}`)
        }
        if (report.staleFailureCandidates > 0) {
          lines.push(`  预存量失败：${report.staleFailureCandidates} 条（改动前已存在，不归本次改动，可 force 交付）`)
        }
        // no_test_infra: project lacks testing infrastructure entirely.
        // Give user-facing guidance rather than generic "run tests" advice.
        if (report.attributionClass === 'no_test_infra') {
          lines.push('', '  ⚠️ 测试基础设施缺失 — 项目没有可自动检测的测试框架或测试文件。')
          lines.push('  run_tests 每次都会以同样原因受阻，继续重试不会改变结果。')
          lines.push('  建议向用户报告：')
          lines.push('    1. 当前项目缺少什么（package.json 中的 test 脚本 / pytest / vitest 等）')
          lines.push('    2. 用户是否需要协助搭建测试框架')
          lines.push('    3. 或者用 bash 运行替代验证（编译检查/手动测试/脚本输出检查）后交付')
          lines.push('  ⚠ 不要只说"请运行测试"——项目根本没有测试可以运行。')
        }
      }

      // Memory-driven review checklist (non-blocking, informational only).
      // Deferred: only append after commit determination so it doesn't
      // clutter the primary gate output.
      const projectMemory = ctx.getProjectMemoryContent?.(params.cwd) ?? readProjectMemory(params.cwd)
      const reviewChecklist = projectMemory
        ? buildReviewPrincipleChecklist({ knowledgeMarkdown: projectMemory, changedFiles: report.ownedFiles })
        : []

      const health = summarizeOwnershipHealth({
        ownedFiles: report.ownedFiles,
        coOwnedFiles: report.coOwnedFiles,
        externalFiles: report.externalFiles,
        dirtyFiles: currentDirtyFiles ?? [...report.ownedFiles, ...report.coOwnedFiles, ...report.externalFiles],
      })
      if (health.warningLines.length > 0) {
        lines.push('', 'Ownership health warnings:')
        lines.push(...health.warningLines.map(line => `  ${line}`))
      }
      if (health.infoLines.length > 0) {
        lines.push('', 'Ownership caveats:')
        lines.push(...health.infoLines.map(line => `  ${line}`))
      }

      if (report.blockingReason) {
        lines.push('', `⚠️  Blocking: ${report.blockingReason}`)
      }

      // P2 cross-session signal: detect claim conflicts with other sessions
      const claimConflicts: Array<{ file: string; holder: string; claimType: string }> = []
      if (ctx.sessionRegistry && ctx.sessionId && report.ownedFiles.length > 0) {
        for (const f of report.ownedFiles) {
          const claim = ctx.sessionRegistry.checkClaim(f)
          if (claim && claim.sessionId !== ctx.sessionId) {
            claimConflicts.push({ file: f, holder: claim.sessionId, claimType: claim.claimType })
          }
        }
        if (claimConflicts.length > 0) {
          lines.push('', '⚠️  Cross-session claim conflicts:')
          for (const c of claimConflicts) {
            const claimKind = c.claimType === 'exclusive' ? 'exclusive lock' : 'shared read'
            lines.push(`  ${c.file} — ${claimKind} held by session ${c.holder}`)
          }
          lines.push('', '  (Continue only if you have verified this conflict is safe to override.)')
        }
      }

      lines.push('', `Attribution: ${report.attributionSummary}`)

      // Failure attribution summary: distinguish "my fault" vs "not my fault" failures.
      // Helps the agent understand: which failures should I fix, which are external?
      {
        const parts: string[] = []
        if (report.currentBlockingFailure) parts.push(`1 条阻断失败（你需处理）`)
        if (report.supersededFailures > 0) parts.push(`${report.supersededFailures} 条预存量（改动前已存在，不归你）`)
        if (parts.length > 0) {
          lines.push(`失败归因：${parts.join(' | ')}`)
          lines.push('→ 只处理"阻断失败"——那是你的改动引入的。预存量失败不归你，可 force 交付。')
        }
      }

      // Recovery journal: detect files that were restored (undo/git checkout) during this session.
      // A clean file after restore may hide unfinished intent — surface it explicitly.
      const recoveries = readUnacknowledged(params.cwd)
      if (recoveries.length > 0) {
        lines.push('', '--- Recovery Journal ---')
        lines.push('  Files restored during this session (edit failure → restore):')
        for (const r of recoveries) {
          lines.push(`  ⚠️  ${r.file} (${r.action}, ~${r.linesLost} lines lost at ${r.ts.slice(11, 19)})`)
        }
        lines.push('', '  ⚠️  Verify no intended changes were lost in these recoveries.')
        lines.push('  If all recovered changes have been re-applied, this warning will clear on next deliver_task.')
      }

      const commit = params.input.commit === true
      const message = params.input.message as string | undefined

      // Task completion audit: surface incomplete items prominently.
      // Prevents silent omissions where the agent claims X is done but only Y was implemented.
      const auditList = params.input.checklist as Array<{ item: string; done: boolean; files?: string[] }> | undefined
      if (auditList && Array.isArray(auditList) && auditList.length > 0) {
        const incomplete = auditList.filter(entry => !entry.done)
        const complete = auditList.filter(entry => entry.done)
        lines.push('', '--- Task Completion Audit ---')
        for (const entry of complete) {
          lines.push(`  ✅ ${entry.item}` + (entry.files?.length ? ` (${entry.files.join(', ')})` : ''))
        }
        for (const entry of incomplete) {
          lines.push(`  ⚠️  NOT DONE: ${entry.item}`)
        }
        if (incomplete.length > 0) {
          // P2: wave-split detection — when a large plan has been partially executed,
          // suggest finishing the current wave before starting the next batch.
          const totalCount = auditList.length
          const doneCount = complete.length
          // E-fix: threshold lowered from >5 to >=4 — a 5-task plan executed in
          // one unbroken batch is exactly the failure mode (session 803d897d).
          if (totalCount >= 4) {
            const remainingRatio = incomplete.length / totalCount
            if (remainingRatio > 0.4) {
              lines.push('', `  💡 ${incomplete.length}/${totalCount} tasks remaining (${Math.round(remainingRatio * 100)}%). Consider pausing after this wave — typecheck+test the completed batch, then continue with the next ${Math.min(incomplete.length, 3)} tasks.`)
            } else {
              lines.push('', `  ⚠️  ${incomplete.length} of ${totalCount} tasks incomplete. Verify these are intentionally deferred to the next wave, not forgotten.`)
            }
          } else {
            lines.push('', '  ⚠️  Incomplete tasks detected. Verify these are intentionally deferred, not forgotten.')
          }
        }
      }

      if (commit) {
        // Atomic commit reminder — injected at the exact moment before commit,
        // not in system prompt. Keeps prompt noise low while catching "accidental
        // batch commit" at the most dangerous moment.
        lines.push(
          '',
          '<atomic-commit-reminder>',
          '提交前只确认本次一个逻辑单元：',
          '1. 是否只包含当前任务文件？',
          '2. 是否混入外部/他人改动？',
          '3. 测试与 typecheck 是否对应本逻辑单元？',
          '4. commit message 是否描述一个原子变更？',
          '</atomic-commit-reminder>',
        )

        const forceGate = params.input.force === true

        // Mechanical-change classification (computed once, reused for gate bypass
        // and post-commit review). Only meaningful when fast-path is enabled.
        let mechanicalClass: import('./change-classification.js').ChangeClassification | undefined
        if (isMechanicalFastPathEnabled(ctx.reviewConfig)) {
          mechanicalClass = classifyChange(
            report.ownedFiles,
            createGitDiffProvider(params.cwd, report.ownedFiles, currentDirtyFiles ?? undefined),
          )
        }

        if (report.state === 'RED') {
          // Superseded failures: failures that were later fixed (already green).
          // force=true allows override when all blocking failures look superseded.
          if (forceGate && report.supersededFailures > 0) {
            lines.push('', '⚠️  RED overridden (force=true): superseded failures detected (these were later fixed).')
            lines.push('   Verify these pre-existing failures are unrelated to your changes before proceeding.')
          } else if (
            report.attributionClass === 'unverified'
            && mechanicalClass?.skipVerification
          ) {
            lines.push('', `✅ 机械式变更 (${mechanicalClass.class})，免验证交付：${mechanicalClass.reason}`)
          } else {
            lines.push('', '❌ Cannot commit: delivery gate is RED.')
            if (report.supersededFailures > 0) {
              lines.push('   (Superseded failures found — these were later fixed, use force=true if pre-existing.)')
            }
            lines.push('', 'Recovery:')
            if (report.blockingReason) {
              lines.push(`  Reason: ${report.blockingReason}`)
            }
            if (report.currentBlockingFailure) {
              lines.push(`  Detail: ${report.currentBlockingFailure}`)
            }
            lines.push('')
            // Unverified: guide to targeted verification instead of full suite
            if (report.ownedFiles.length > 0 && report.verificationCount === 0) {
              lines.push('  → Files are unverified. Run TARGETED tests first:')
              lines.push('    Use run_tests with filter="test-file-name" for each changed file.')
              lines.push('    Use related_tests(sourceFile) to find the right test file.')
              lines.push('')
              lines.push('    Do NOT run the full test suite as first step — it may timeout.')
            } else {
              lines.push('  → Fix the blocking issue above, then re-run deliver_task.')
              lines.push('    If tests keep timing out, run them in smaller batches by directory.')
            }
            return { content: lines.join('\n'), isError: true }
          }
        }
        if (report.state === 'YELLOW') {
          const stanceHint = detectSymptomPatch(params.cwd)
          if (stanceHint) lines.push('', stanceHint)
        }
        if (!message) {
          lines.push('', '❌ Commit requires a "message" parameter.')
          return { content: lines.join('\n'), isError: true }
        }
        // Adopt external files into owned set (cross-session takeover)
        const adoptFiles = params.input.adopt as string[] | undefined
        if (adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length > 0) {
          // Validate: adopted files must be external OR co-owned (shared ownership).
          // Co-owned files can be adopted when the other session is done/crashed.
          const externalSet = new Set(report.externalFiles)
          const coOwnedSet = new Set(report.coOwnedFiles)
          const adoptableSet = new Set([...externalSet, ...coOwnedSet])
          const notAdoptable = adoptFiles.filter(f => !adoptableSet.has(f))
          if (notAdoptable.length > 0) {
            lines.push('', `❌ Adopt: file(s) not in external or co-owned files: ${notAdoptable.join(', ')}. Only external and co-owned files can be adopted.`)
            return { content: lines.join('\n'), isError: true }
          }
          const adopted = ctx.ownership.adoptFiles(adoptFiles)
          if (adopted.length > 0) {
            const wasCoOwned = adopted.filter(f => coOwnedSet.has(f))
            const wasExternal = adopted.filter(f => externalSet.has(f))
            if (wasCoOwned.length > 0) lines.push('', `🔓 Adopted ${wasCoOwned.length} co-owned file(s) into exclusive ownership:`)
            if (wasExternal.length > 0) lines.push('', `🔓 Adopted ${wasExternal.length} external file(s) into owned set:`)
            for (const f of adopted) lines.push(`   ${f}`)
            if (wasCoOwned.length > 0) lines.push('', '  ⚠️ These files were shared with another session. Verify the other session has finished before committing.')
            if (wasExternal.length > 0) lines.push('', '  ⚠️ These files were modified by another session. Verify the changes are correct before committing.')
            // Refresh report after adoption — the gate may change
          }
        } else if (adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length === 0) {
          // adopt: [] is equivalent to omitting adopt — no files to adopt, not an error.
          // Previously this was treated as a user mistake, but callers (especially
          // model-generated tool calls) may pass an explicit empty array to mean "no adoption".
        }

        const postAdoptionReport = adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length > 0
          ? ctx.gate.getReport([], currentDirtyFiles, ctx.getCurrentSnapshotRef?.())
          : report
        if (postAdoptionReport.state === 'RED') {
          // Mechanical fast-path also applies to the post-adoption gate
          // (when no adoption happens, postAdoptionReport === report, and the
          // bypass was already decided above — don't re-block).
          const postAdoptionBypass = postAdoptionReport.attributionClass === 'unverified'
            && mechanicalClass?.skipVerification
          if (!postAdoptionBypass) {
            lines.push('', '❌ Cannot commit: delivery gate is RED after adoption.')
            if (postAdoptionReport.blockingReason) {
              lines.push(`  Reason: ${postAdoptionReport.blockingReason}`)
            }
            if (postAdoptionReport.currentBlockingFailure) {
              lines.push(`  Detail: ${postAdoptionReport.currentBlockingFailure}`)
            }
            lines.push('  → Run verification for the adopted files, then re-run deliver_task.')
            return { content: lines.join('\n'), isError: true }
          }
        }

        // Resolve files to commit: subset from `files` param, or all owned
        // Note: after adoption, use refreshed owned set from ledger (not stale report)
        const requestedFiles = params.input.files as string[] | undefined
        const currentOwnedFiles = ctx.ownership.getOwnedFiles()
        let filesToCommit = currentOwnedFiles

        if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length > 0) {
          const ownedSet = new Set(currentOwnedFiles)
          const notOwned = requestedFiles.filter(f => !ownedSet.has(f))
          if (notOwned.length > 0) {
            lines.push('', `❌ File(s) not in owned files: ${notOwned.join(', ')}. Cannot commit non-owned files.`)
            return { content: lines.join('\n'), isError: true }
          }
          filesToCommit = requestedFiles
        } else if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length === 0) {
          lines.push('', '❌ No files specified for commit. Provide non-empty files array or omit to commit all owned files.')
          return { content: lines.join('\n'), isError: true }
        }

        const commitConflictFiles = new Set(filesToCommit)
        const blockingClaimConflicts = claimConflicts.filter(conflict => commitConflictFiles.has(conflict.file))
        if (blockingClaimConflicts.length > 0 && !forceGate) {
          lines.push('', '❌ Cannot commit: cross-session claim conflicts are present.')
          lines.push('   → Resolve the other session claim or use force=true only after independently verifying the override is safe.')
          return { content: lines.join('\n'), isError: true }
        }
        if (blockingClaimConflicts.length > 0 && forceGate) {
          lines.push('', '⚠️ Cross-session claim conflicts overridden with force=true. Verify the other session has finished or approved the takeover.')
        }

        // ── PRE-COMMIT GATES (blocking) ──────────────────────────────────
        // Static checks that don't need worker API calls — run before commit.

        // D-fix: cheap static wrote-but-never-read check. Mechanically catches
        // the modelOverride class of dead wiring (field/symbol added, zero
        // read-side consumers) at the moment of delivery. YELLOW, non-blocking.
        try {
          const deadSymbols = (ctx.detectWroteButNeverRead ?? detectWroteButNeverRead)(params.cwd, filesToCommit)
          lines.push(...formatWroteButNeverRead(deadSymbols))
        } catch {
          // best-effort: never let the nudge break delivery
        }

        // 虚假绿灯对偶检查：字段被生产代码读取，却只有测试 fixture 赋值、生产无写入点
        // = fixture 伪造了真实系统不产出的形状。YELLOW，非阻断。仅抓子型A（生产零写入）；
        // 子型B（写入点存在但运行时永空）是 review 门的职责。
        try {
          const falseGreen = (ctx.detectReadButNeverProduced ?? detectReadButNeverProduced)(params.cwd, filesToCommit)
          lines.push(...formatReadButNeverProduced(falseGreen))
        } catch {
          // best-effort: never let the nudge break delivery
        }

        // Probe-residue gate: scan owned files for leftover debug probes
        // (console.log/debugger/.only etc.). YELLOW, non-blocking — the model
        // may have intentionally added logging. fs re-scan is authoritative:
        // probes already cleaned by a later edit won't be in the file.
        try {
          const scanner = ctx.scanProbes ?? ((files, cwd) => {
            return scanFilesForProbes(files, cwd, (p) => {
              try { return readFileSync(p, 'utf-8') } catch { return null }
            })
          })
          const probeHits = scanner(filesToCommit, params.cwd)
          if (probeHits.length > 0) {
            lines.push(...formatProbeHits(probeHits))
          }
        } catch {
          // best-effort: never let probe scanning break delivery
        }

        // Cohesion gate: RED if files span too many areas (unless force=true)
        // When files were adopted (cross-session takeover), auto-override cohesion
        // since the adoption scope is intentional.
        const cohesionOverride = forceGate
          || (adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length > 0)
        const cohesion = checkCommitCohesion(filesToCommit)
        if (cohesion.needsWarning && !cohesionOverride) {
          lines.push('', ...cohesion.warningLines.map(l => `  ${l}`))
          return { content: lines.join('\n'), isError: true }
        }
        if (cohesion.needsWarning && cohesionOverride) {
          lines.push('', '  ⚠️ Cohesion gate overridden with force=true. Verify this is truly one logical unit.')
        }

        // ── COMMIT (no longer blocked by review) ─────────────────────────
        // Review is post-commit (advisory) — the commit must land first so
        // the main loop never stalls on a slow/timeout review worker.

        // Capture HEAD before the commit so the result carries verifiable
        // evidence that a new commit actually landed (vs. agent guessing from
        // a possibly-stale git status snapshot).
        const headBefore = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 5000 })
        const headBeforeHash = headBefore.status === 0 ? headBefore.stdout.trim() : null

        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg }))
        const commitResult = executor(params.cwd, filesToCommit, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          return { content: lines.join('\n'), isError: true }
        }
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${filesToCommit.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
        // Post-commit truth readback: verify HEAD actually moved + surface hash.
        const headAfter = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 5000 })
        const headAfterHash = headAfter.status === 0 ? headAfter.stdout.trim() : null
        if (headBeforeHash && headAfterHash) {
          if (headBeforeHash !== headAfterHash) {
            lines.push(`   VERIFIED: HEAD moved ${headBeforeHash} → ${headAfterHash}. The commit is real — do NOT re-attempt it.`)
          } else {
            lines.push(`   ⚠️ WARNING: HEAD did not move (still ${headAfterHash}). The commit may not have landed — verify with git log before retrying.`)
          }
        }
        const readback = spawnSync('git', ['-c', 'core.quotePath=false', 'show', '--stat', '--format=%h%d', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 10_000 })
        if (readback.status === 0 && readback.stdout.trim()) {
          lines.push('', '--- actual changes (git show --stat) ---')
          lines.push(readback.stdout.trim())
        }
        // Acknowledge recovery journal entries — the commit confirms intent was preserved.
        if (recoveries.length > 0) acknowledgeAll(params.cwd)

        // ── POST-COMMIT REVIEW (advisory, non-blocking) ──────────────────
        // Review runs AFTER the commit so a slow/timeout worker never stalls
        // the main loop or blocks delivery. Findings are surfaced as warnings;
        // the commit has already landed and cannot be un-done by review.
        // The reviewDepth guard prevents verifier/patcher child contexts from
        // recursively reviewing themselves.
        // RIVET_REVIEW_DISCIPLINE=0 / false / off / no disables the gate (default: enabled).
        const explicitReviewLevel = params.input.review_level as ReviewScale | undefined
        const skipAutoReview = params.input.skipAutoReview === true
          || ctx.isGoalActive?.() === true
          || ctx.reviewConfig?.skipAuto === true
        const goalAchieved = ctx.isGoalAchieved?.() === true
        const goalVerdict = ctx.getLastVerdict?.() ?? null

        // Goal-achieved commit: auto-upgrade to L3 for final review sweep.
        // Best-effort — if review deps are unavailable the commit still lands.
        const effectiveReviewLevel: ReviewScale | undefined = goalAchieved && !explicitReviewLevel
          ? 'L3'
          : explicitReviewLevel

        const change: ChangeSet = {
          files: filesToCommit,
          crossModule: isCrossModule(filesToCommit),
          isFix: isFixContext(message),
          goalActive: ctx.isGoalActive?.() === true,
          largeFiles: collectLargeFiles(params.cwd, filesToCommit),
          ...(effectiveReviewLevel ? { forceLevel: effectiveReviewLevel } : {}),
          ...(mechanicalClass ? { changeClass: mechanicalClass } : {}),
        }

        // Typecheck backstop (Component B) — run a scoped tsc on the changed
        // files; a real type error that tests/esbuild missed escalates review to
        // L3 and is surfaced FIRST in focusHint (more urgent than blast radius).
        // Advisory: wrapped so it never blocks the commit (already landed) or
        // deliver_task. ctx.typecheckRunner is undefined in prod → real tsc.
        // Covers both scoped errors (in changed files) and cross-file drift
        // (new errors in non-changed files from definition changes) — the
        // latter is the "24-error class" that scoped-only filtering missed.
        if (typecheckGateEnabled()) {
          try {
            const tc = await runChangedFilesTypecheckMemo(params.cwd, change.files, ctx.typecheckRunner)
            if (tc) {
              change.forceLevel = 'L3'
              const note = `Typecheck — ${tc.summary}`
              change.focusHint = change.focusHint ? `${note} | ${change.focusHint}` : note
            }
          } catch { /* advisory: typecheck gate must never fail delivery */ }
        }

        // Inject meridian blast radius into focusHint so verifier/inspector
        // know which downstream consumers to verify. Absolute paths filtered
        // (repo-relative LIKE silently returns empty on absolute paths).
        const meridianDb = ctx.meridianIndexer?.getDb()
        const relChangeFiles = change.files.filter(f => !isAbsolute(f))
        if (meridianDb && relChangeFiles.length > 0) {
          const impact = analyzeImpact(meridianDb, relChangeFiles)
          const parts: string[] = []
          if (impact.direct.length > 0)
            parts.push(`downstream consumers: ${impact.direct.slice(0, 8).join(', ')}${impact.direct.length > 8 ? ` (+${impact.direct.length - 8} more)` : ''}`)
          if (impact.tests.length > 0)
            parts.push(`related tests: ${impact.tests.slice(0, 8).join(', ')}${impact.tests.length > 8 ? ` (+${impact.tests.length - 8} more)` : ''}`)
          if (parts.length > 0) {
            const blast = `Blast radius — ${parts.join('; ')}`
            change.focusHint = change.focusHint ? `${change.focusHint} | ${blast}` : blast
          }
        }

        // Surface the judge verdict alongside the delivery report so L3 review
        // Surface the judge verdict alongside the delivery report so L3 review
        // can focus on code quality — the judge already established functional
        // completeness. When verdict is null, the judge didn't run (disabled,
        // no coordinator, or goal completed before first judge invocation).
        if (goalVerdict) {
          const v = goalVerdict
          if (v.overall === 'verified') {
            lines.push('', `✅ Goal judge: verified (${v.criteriaMet}/${v.criteriaTotal} criteria met). L3 review can focus on code quality.`)
          } else if (v.overall === 'rejected') {
            lines.push('', `⚠️ Goal judge: rejected (${v.criteriaUnmet} unmet of ${v.criteriaTotal}). Accepted at judge cap — residual: ${v.summary}`)
          } else {
            lines.push('', `⚠️ Goal judge: inconclusive. Accepted unverified — ${v.summary}`)
          }
        }

        // Suppress auto review when goal is active OR caller explicitly skips.
        // Goal-driven auto-continuation can't afford child review worker stalls.
        if (skipAutoReview) {
          lines.push('', '⏭ 自动审查已跳过（goal 模式或 skipAutoReview）。')
        } else if (reviewDepth === 0 && shouldRouteReviewWorkflow(change) && isReviewDisciplineEnabled()) {
          // Batch: skip if a review was already launched within the cooldown window.
          const now = Date.now()
          if (now - lastPostCommitReviewAt < POST_COMMIT_REVIEW_COOLDOWN_MS) {
            const sinceSec = Math.round((now - lastPostCommitReviewAt) / 1000)
            const windowSec = Math.round(POST_COMMIT_REVIEW_COOLDOWN_MS / 1000)
            lines.push('', `⏭ 提交后审查跳过：距上轮审查仅 ${sinceSec}s（<${windowSec}s 冷却窗口）。本轮变更未被审查，必要时用 \`/review\` 手动覆盖。`)
          } else {
            const route = ctx.routeReviewWorkflow ?? (ctx.reviewDeps ? routeReviewWorkflow : undefined)
            if (!route || !ctx.reviewDeps) {
              // Advisory: review deps unavailable is a caveat, not a blocker.
              lines.push('', '⚠️ 提交后审查跳过：审查依赖不可用（ReviewRouter 未接入）。')
            } else {
              const reviewMode: ReviewMode = change.forceLevel ? 'manual' : 'auto'
              const REVIEW_TIMEOUT_MS = reviewWorkflowBudgetMs(reviewMode, change.forceLevel)
              const reviewAbort = new AbortController()
              if (params.abortSignal) {
                if (params.abortSignal.aborted) {
                  lines.push('', '⚠️ 提交后审查跳过：工具已取消。')
                } else {
                  params.abortSignal.addEventListener('abort', () => reviewAbort.abort(), { once: true })
                }
              }
              if (!params.abortSignal?.aborted) {
                // 进度可见：通过 onOutput streaming 回调推送中间状态，
                // 用户在审查运行期间看到进度而非黑盒等待。
                const budgetSec = Math.round(REVIEW_TIMEOUT_MS / 1000)
                params.onOutput?.(`\n⏳ 提交后审查启动中 (${reviewMode}${change.forceLevel ? ' ' + change.forceLevel : ''}, ≤${budgetSec}s)...\n`)
                lastPostCommitReviewAt = Date.now()
                let outcome: ReviewOutcome
                let reviewTimer: NodeJS.Timeout | undefined
                try {
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    reviewTimer = setTimeout(() => {
                      reviewAbort.abort()
                      reject(new Error('Review workflow timed out'))
                    }, REVIEW_TIMEOUT_MS)
                  })
                  outcome = await Promise.race([
                    route(change, ctx.reviewDeps, { abortSignal: reviewAbort.signal, mode: reviewMode, depthLayer: ctx.getDepthLayer?.() }),
                    timeoutPromise,
                  ])
                } catch (err) {
                  const reason = err instanceof Error ? err.message : String(err)
                  // Review is best-effort post-commit: a timeout/crash never blocks
                  // delivery — the commit already landed. Report honestly.
                  outcome = {
                    tier: reviewMode === 'auto' ? 'auto' : (effectiveReviewLevel ?? 'L2'),
                    verdict: 'inconclusive',
                    rounds: 0,
                    evidence: `post-commit review DID NOT run (${reason.includes('timed out') ? 'timed out' : 'infra failure'}: ${reason})`,
                    infraFailures: [{ kind: reason.includes('timed out') ? 'timeout' : 'crash', claim: reason }],
                  }
                } finally {
                  if (reviewTimer) clearTimeout(reviewTimer)
                }
                // Review infra health observability (/status): auto runs only.
                if (reviewMode === 'auto' && outcome.rounds !== undefined && outcome.verdict !== 'nudge') {
                  if (outcome.verdict === 'inconclusive') {
                    recordAutoReviewRun({ ran: false, failureKinds: (outcome.infraFailures ?? []).map(f => f.kind) })
                  } else {
                    recordAutoReviewRun({ ran: true, ...(outcome.recoveredByRetry ? { recoveredByRetry: true } : {}) })
                  }
                }
                if (outcome.verdict === 'rejected' || outcome.escalated) {
                  // Advisory: the commit has already landed. Surface the finding
                  // as a strong warning + follow-up recommendation, not a block.
                  lines.push('', `⚠️ 审查门发现问题 (${outcome.tier})：${outcome.evidence ?? '对抗性审查未验证此交付'}`)
                  if (typeof outcome.rounds === 'number') lines.push(`   轮次：${outcome.rounds}`)
                  lines.push('   → 提交已落地。请在后续提交中处理审查发现。')
                  lines.push('   ⚠ 以上审查意见来自 worker，未经主控独立核验。汇报用户前请用 grep/read 确认每条声称的文件:行号真实存在。')
                } else if (outcome.verdict === 'verified') {
                  if (outcome.infraFailures && outcome.infraFailures.length > 0) {
                    lines.push('', `⚠️ 审查门 YELLOW (${outcome.tier})：审查基础设施有注意事项，交付已通过可用证据验证。`)
                    lines.push(`   ${outcome.evidence ?? '已通过审查基础设施注意事项验证'}`)
                  } else {
                    lines.push('', `✅ 审查通过 (${outcome.tier})：${outcome.evidence ?? '已验证'}`)
                  }
                } else if (outcome.verdict === 'inconclusive') {
                  lines.push('', `⚠️ 审查未决 (${outcome.tier})：${outcome.evidence ?? '提交后审查未运行（基础设施故障）'}`)
                  lines.push('   → 此变更未经审查。运行 /review max 进行完整编队审查。')
                } else if (outcome.verdict === 'nudge') {
                  lines.push('', `⚠️ 审查提醒 (${outcome.tier})：请在后续工作中应用审查纪律。`)
                  lines.push('通用开发方法论：')
                  for (const directive of GENERAL_DEV_DISCIPLINES) lines.push(`  - ${directive}`)
                }
              }
              }
          }
        }
      }

      // Append review principle checklist at end (non-blocking, informational)
      if (reviewChecklist.length > 0) {
        lines.push('', '审查原则清单：')
        for (const item of reviewChecklist.slice(0, 2)) {
          lines.push(`  - ${item.question}`)
        }
        if (reviewChecklist.length > 2) {
          lines.push(`  ... 还有 ${reviewChecklist.length - 2} 条原则`)
        }
      }

      return { content: lines.join('\n') }
    },

    requiresApproval(params: ToolCallParams): boolean {
      return params.input.commit === true
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,

    // Review is now post-commit (advisory). The commit itself is sub-second,
    // and the review worker budget no longer blocks the main loop — the tool
    // timeout must still dominate the review budget so the worker can finish,
    // but the main loop is never stalled waiting for it to gate the commit.
    timeoutMs: (params) => {
      const level = params?.input?.review_level as ReviewScale | undefined
      const mode: ReviewMode = level ? 'manual' : 'auto'
      return reviewWorkflowBudgetMs(mode, level) + 60_000
    },
  }
}
