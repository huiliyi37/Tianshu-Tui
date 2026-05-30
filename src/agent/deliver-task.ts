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
}

function parseNulFileList(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

function readProjectMemory(cwd: string): string | undefined {
  try { return readFileSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8') } catch { return undefined }
}

function gitNameList(cwd: string, args: string[]): string[] | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 })
  if (result.status !== 0) return null
  return parseNulFileList(result.stdout)
}

/**
 * Detect a "symptom-patch": a tiny single-file change touching only fallback
 * operators (`??` `||` default values). These are the shape of the trained-mode
 * reflex — patch the last hop, not the root. Returns a stance hint, or null.
 */
export function detectSymptomPatch(cwd: string): string | null {
  const res = spawnSync('git', ['diff', '--numstat', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (res.status !== 0) return null
  const rows = res.stdout.split('\n').filter(Boolean)
    .map(l => l.split('\t'))
    .filter(c => c.length === 3 && !(c[2] ?? '').includes('test'))
  if (rows.length !== 1) return null
  const row = rows[0]!
  const added = Number(row[0]) || 0
  if (added > 2) return null
  const patch = spawnSync('git', ['diff', 'HEAD', '--', row[2]!], { cwd, encoding: 'utf-8', timeout: 5000 })
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

export function createDeliverTaskTool(getB1Context: () => B1Context): Tool {
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
          force: {
            type: 'boolean',
            description: 'Override cohesion gate. Only use when the commit truly is one logical unit despite spanning multiple areas.',
          },
        },
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const ctx = getB1Context()
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

      if (commit) {
        if (report.state === 'RED') {
          lines.push('', '❌ Cannot commit: delivery gate is RED.')
          return { content: lines.join('\n'), isError: true }
        }
        if (report.state === 'YELLOW') {
          const stanceHint = detectSymptomPatch(params.cwd)
          if (stanceHint) lines.push('', stanceHint)
        }
        if (!message) {
          lines.push('', '❌ Commit requires a "message" parameter.')
          return { content: lines.join('\n'), isError: true }
        }
        // Resolve files to commit: subset from `files` param, or all owned
        const requestedFiles = params.input.files as string[] | undefined
        let filesToCommit = report.ownedFiles

        if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length > 0) {
          const ownedSet = new Set(report.ownedFiles)
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

        // Cohesion gate: RED if files span too many areas (unless force=true)
        const forceOverride = params.input.force === true
        const cohesion = checkCommitCohesion(filesToCommit)
        if (cohesion.needsWarning && !forceOverride) {
          lines.push('', ...cohesion.warningLines.map(l => `  ${l}`))
          return { content: lines.join('\n'), isError: true }
        }
        if (cohesion.needsWarning && forceOverride) {
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
        const readback = spawnSync('git', ['show', '--stat', '--format=%h%d', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 10_000 })
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
