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
import { join, resolve } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { DeliveryGateV2 } from './delivery-gate-v2.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import { commitScopedFiles, type ScopedCommitResult } from './scoped-git-commit.js'
import { buildReviewPrincipleChecklist } from './review-principle-checklist.js'

export interface B1Context {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  gate: DeliveryGateV2
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

export function collectCurrentDirtyFiles(cwd: string): string[] | undefined {
  const unstaged = gitNameList(cwd, ['diff', '--name-only', '-z'])
  const staged = gitNameList(cwd, ['diff', '--cached', '--name-only', '-z'])
  const untracked = gitNameList(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!unstaged || !staged || !untracked) return undefined

  const files = new Set<string>()
  for (const file of [...unstaged, ...staged, ...untracked]) {
    files.add(file)
    // Tool inputs are often absolute paths, while git reports project-relative
    // paths. Keep both forms so DeliveryGate can match either ledger encoding.
    files.add(resolve(cwd, file))
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
- message: commit message (required if commit=true)`,
      input_schema: {
        type: 'object',
        properties: {
          commit: { type: 'boolean', description: 'Request scoped commit of owned files' },
          message: { type: 'string', description: 'Commit message (required if commit=true)' },
        },
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const ctx = getB1Context()
      ctx.ownership.autoOwnFromLedger()
      const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? collectCurrentDirtyFiles(params.cwd)
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

      if (report.supersededFailures > 0) {
        lines.push(`Superseded verification failures: ${report.supersededFailures}`)
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
        externalFiles: report.externalFiles,
        dirtyFiles: [...report.ownedFiles, ...report.externalFiles],
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

      lines.push('', `Attribution: ${report.attributionSummary}`)

      const commit = params.input.commit === true
      const message = params.input.message as string | undefined

      if (commit) {
        if (report.state === 'RED') {
          lines.push('', '❌ Cannot commit: delivery gate is RED.')
          return { content: lines.join('\n'), isError: true }
        }
        if (!message) {
          lines.push('', '❌ Commit requires a "message" parameter.')
          return { content: lines.join('\n'), isError: true }
        }
        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg }))
        const commitResult = executor(params.cwd, report.ownedFiles, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          return { content: lines.join('\n'), isError: true }
        }
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${report.ownedFiles.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
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
