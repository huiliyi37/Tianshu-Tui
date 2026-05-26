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
 * 不会自动执行 git commit —— agent 应读取报告后自行决定。
 * 这是"交付门判断"，不是"交付执行"。
 *
 * HEARTH 兼容：交付报告可沉积为 cycle_close 的 durable evidence。
 * Songline 兼容：交付状态是 obligation fulfillment 信号，可沉积 pheromone。
 *
 * @module deliver-task
 * @task B1-8
 */

import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { DeliveryGateV2 } from './delivery-gate-v2.js'
import { summarizeOwnershipHealth } from './ownership-health.js'

export interface B1Context {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  gate: DeliveryGateV2
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
- Does NOT automatically commit — agent must read report and decide

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
      const report = ctx.gate.getReport([])

      const lines: string[] = [
        `Delivery Gate: ${report.state}`,
        `Task: ${report.taskId}`,
        '',
        `Owned files (${report.ownedFileCount}):`,
        ...(report.ownedFiles.length > 0
          ? report.ownedFiles.map(f => `  ${f}`)
          : ['  (none)']),
        '',
        `External files (${report.externalFileCount}):`,
        ...(report.externalFiles.length > 0
          ? report.externalFiles.map(f => `  ${f}`)
          : ['  (none)']),
        '',
        `Verifications: ${report.verificationCount}`,
      ]

      const health = summarizeOwnershipHealth({
        ownedFiles: report.ownedFiles,
        externalFiles: report.externalFiles,
        dirtyFiles: [...report.ownedFiles, ...report.externalFiles],
      })
      if (health.warningLines.length > 0) {
        lines.push('', 'Ownership health warnings:')
        lines.push(...health.warningLines.map(line => `  ${line}`))
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
        lines.push('', `✅ Ready to commit with message: "${message}"`)
        lines.push(`   (scoped to ${report.ownedFileCount} owned file(s))`)
        lines.push('   Use git commit to execute.')
      }

      const isError = report.state === 'RED'
      return { content: lines.join('\n'), isError }
    },

    requiresApproval(params: ToolCallParams): boolean {
      return params.input.commit === true
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}
