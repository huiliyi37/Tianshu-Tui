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

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { DeliveryGateV2 } from './delivery-gate-v2.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import { commitScopedFiles, type ScopedCommitResult } from './scoped-git-commit.js'
import { buildReviewPrincipleChecklist } from './review-principle-checklist.js'
import { checkCommitCohesion } from './commit-cohesion.js'
import { isCrossModule, isFixContext, type ChangeSet } from './review-discipline.js'
import { routeReviewWorkflow, type ReviewRouterDeps } from './review-router.js'
import { isReviewDisciplineEnabled } from '../config/review-discipline-config.js'

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
}

function parseNulFileList(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

function readProjectMemory(cwd: string): string | undefined {
  try { return readFileSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8') } catch { return undefined }
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
  const rows = res.stdout.split('\n').filter(Boolean)
    .map(l => l.split('\t'))
    .filter(c => c.length === 3 && !(c[2] ?? '').includes('test'))
  if (rows.length !== 1) return null
  const row = rows[0]!
  const added = Number(row[0]) || 0
  if (added > 2) return null
  const patch = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', row[2]!], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (patch.status !== 0) return null
  const addedLines = patch.stdout.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'))
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
- force: set to true to override the cohesion gate when committing many files across multiple areas. Use sparingly.`,
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
        },
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const ctx = getB1Context(params)
      const reviewDepth = params.reviewDepth ?? ctx.reviewDepth ?? 0
      ctx.ownership.autoOwnFromLedger()
      const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? collectCurrentDirtyFiles(params.cwd)
      if (currentDirtyFiles) ctx.ownership.autoOwnFromBaseline(currentDirtyFiles)
      const report = ctx.gate.getReport([], currentDirtyFiles)

      const lines: string[] = [
        `Delivery Gate: ${report.state}`,
        `Task: ${report.taskId}`,
        '',
        `Owned files (${report.ownedFileCount}):`,
        ...(report.ownedFiles.length > 0
          ? report.ownedFiles.map(f => `  ${f}`)
          : ['  (none)']),
        '',
        `Co-owned files (${report.coOwnedFileCount}):`,
        ...(report.coOwnedFiles.length > 0
          ? report.coOwnedFiles.map(f => `  ${f}`)
          : ['  (none)']),
        '',
        `Historical owned files (${report.historicalOwnedFileCount}):`,
        ...(report.historicalOwnedFiles.length > 0
          ? report.historicalOwnedFiles.map(f => `  ${f}`)
          : ['  (none)']),
        '',
        `External files (${report.externalFileCount}):`,
        ...(report.externalFiles.length > 0
          ? report.externalFiles.map(f => `  ${f}`)
          : ['  (none)']),
        '',
        `Verifications: ${report.verificationCount}`,
      ]

      const hasVerificationDiagnostics = report.currentBlockingFailure
        || report.staleFailureCandidates > 0
        || report.toolInvocationFailureCandidates.length > 0
        || report.shortestNextStep
      if (hasVerificationDiagnostics) {
        lines.push('', 'Verification diagnostics:')
        if (report.currentBlockingFailure) {
          lines.push(`  Current blocking failure: ${report.currentBlockingFailure}`)
        }
        if (report.staleFailureCandidates > 0) {
          lines.push(`  Stale failure candidates: ${report.staleFailureCandidates}`)
        }
        if (report.toolInvocationFailureCandidates.length > 0) {
          lines.push('  Tool invocation failure candidates:')
          for (const candidate of report.toolInvocationFailureCandidates) {
            lines.push(`    - ${candidate}`)
          }
        }
        if (report.shortestNextStep) {
          lines.push(`  Shortest next step: ${report.shortestNextStep}`)
        }
        // When tool invocation failures are present (timeout, crash), suggest
        // batch running tests with a longer timeout to increase verification coverage.
        if (report.toolInvocationFailureCandidates.length > 0) {
          // Check if the shortest next step looks like a test command
          const nextStep = report.shortestNextStep ?? ''
          if (nextStep.includes('--test') || nextStep.includes('test')) {
            lines.push('', '  💡 Tests timed out or crashed. Try:')
            lines.push('     - Increase bash timeout: pass timeout=300000 for full suites')
            lines.push('     - Run in batches: split by directory (src/tui/__tests__/, src/agent/__tests__/, etc.)')
            lines.push('     - Run only related tests first, then expand scope')
          }
        }
      }

      // Memory-driven review checklist (non-blocking, informational only)
      const projectMemory = ctx.getProjectMemoryContent?.(params.cwd) ?? readProjectMemory(params.cwd)
      const checklist = projectMemory
        ? buildReviewPrincipleChecklist({ knowledgeMarkdown: projectMemory, changedFiles: report.ownedFiles })
        : []
      if (checklist.length > 0) {
        lines.push('', 'Review principle checklist:')
        for (const item of checklist) {
          lines.push(`  - ${item.question}`)
          lines.push(`    Source: ${item.source}`)
          lines.push(`    Reason: ${item.reason}`)
        }
      }

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
      if (ctx.sessionRegistry && ctx.sessionId && report.ownedFiles.length > 0) {
        const conflicts: Array<{ file: string; holder: string; claimType: string }> = []
        for (const f of report.ownedFiles) {
          const claim = ctx.sessionRegistry.checkClaim(f)
          if (claim && claim.sessionId !== ctx.sessionId) {
            conflicts.push({ file: f, holder: claim.sessionId, claimType: claim.claimType })
          }
        }
        if (conflicts.length > 0) {
          lines.push('', '⚠️  Cross-session claim conflicts:')
          for (const c of conflicts) {
            const claimKind = c.claimType === 'exclusive' ? 'exclusive lock' : 'shared read'
            lines.push(`  ${c.file} — ${claimKind} held by session ${c.holder}`)
          }
          lines.push('', '  (Continue only if you have verified this conflict is safe to override.)')
        }
      }

      lines.push('', `Attribution: ${report.attributionSummary}`)

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
          lines.push('', '  ⚠️  Incomplete tasks detected. Verify these are intentionally deferred, not forgotten.')
        }
      }

      if (commit) {
        const forceGate = params.input.force === true
        if (report.state === 'RED') {
          // Stale failure candidates: failures that likely pre-date this change.
          // force=true allows override when all blocking failures look pre-existing.
          if (forceGate && report.staleFailureCandidates > 0) {
            lines.push('', '⚠️  RED overridden (force=true): stale failure candidates detected.')
            lines.push('   Verify these pre-existing failures are unrelated to your changes before proceeding.')
          } else {
            lines.push('', '❌ Cannot commit: delivery gate is RED.')
            if (report.staleFailureCandidates > 0) {
              lines.push('   (Stale failure candidates found — use force=true if pre-existing.)')
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

        // Review discipline gate: fix commits must pass an independent review route when wired.
        // The reviewDepth guard prevents verifier/patcher child contexts from recursively reviewing themselves.
        // RIVET_REVIEW_DISCIPLINE=0 / false / off / no disables the gate (default: enabled).
        if (reviewDepth === 0 && isFixContext(message) && isReviewDisciplineEnabled()) {
          const route = ctx.routeReviewWorkflow ?? (ctx.reviewDeps ? routeReviewWorkflow : undefined)
          if (route && ctx.reviewDeps) {
            const change: ChangeSet = {
              files: filesToCommit,
              crossModule: isCrossModule(filesToCommit),
              isFix: true,
            }
            const outcome = await route(change, ctx.reviewDeps)
            if (outcome.verdict === 'rejected' || outcome.escalated) {
              lines.push('', `❌ ReviewRouter RED (${outcome.tier}): ${outcome.evidence ?? 'adversarial review did not verify this fix commit'}`)
              if (typeof outcome.rounds === 'number') lines.push(`   Rounds: ${outcome.rounds}`)
              lines.push('   → Fix the review finding, collect command + observed output evidence, then re-run deliver_task.')
              return { content: lines.join('\n'), isError: true }
            }
            if (outcome.verdict === 'verified') {
              lines.push('', `✅ ReviewRouter verified (${outcome.tier}): ${outcome.evidence ?? 'verified'}`)
            } else if (outcome.verdict === 'nudge') {
              lines.push('', `⚠️ ReviewRouter nudge (${outcome.tier}): apply review disciplines before committing.`)
            }
          }
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

        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg }))
        const commitResult = executor(params.cwd, filesToCommit, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          return { content: lines.join('\n'), isError: true }
        }
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${filesToCommit.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
        // Post-commit truth readback: verify actual landed changes + surface hash
        const readback = spawnSync('git', ['-c', 'core.quotePath=false', 'show', '--stat', '--format=%h%d', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 10_000 })
        if (readback.status === 0 && readback.stdout.trim()) {
          lines.push('', '--- actual changes (git show --stat) ---')
          lines.push(readback.stdout.trim())
        }
      }

      return { content: lines.join('\n') }
    },

    requiresApproval(params: ToolCallParams): boolean {
      return params.input.commit === true
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}
