/**
 * 按次预算（Wave 9）——`delegate_task` / `delegate_batch` 共用的预算入参。
 *
 * 此前两个工具的 schema 里没有任何预算字段：查一个 URL 和扫一遍代码库吃同一份
 * 24 轮 / 同一个 profile 超时。`createReadOnlyWorkOrder` 本来就收 `budget`，缺的
 * 只是把它暴露到工具层。
 *
 * 上下限是护栏而非建议值：太小会让 worker 一轮都跑不完就被切断（还得走续跑），
 * 太大会把外层工具超时一起抬到不合理的量级。
 */
import { z } from 'zod'
import type { WorkerBudget } from '../agent/work-order.js'

export const MIN_DELEGATE_MAX_TURNS = 2
export const MAX_DELEGATE_MAX_TURNS = 100
export const MIN_DELEGATE_TIMEOUT_MS = 30_000
export const MAX_DELEGATE_TIMEOUT_MS = 2_700_000

export const delegateMaxTurnsSchema = z.number().int()
  .min(MIN_DELEGATE_MAX_TURNS).max(MAX_DELEGATE_MAX_TURNS).optional()

export const delegateTimeoutMsSchema = z.number().int()
  .min(MIN_DELEGATE_TIMEOUT_MS).max(MAX_DELEGATE_TIMEOUT_MS).optional()

export const MAX_TURNS_TOOL_DESCRIPTION =
  `可选，本次派发的轮次预算（${MIN_DELEGATE_MAX_TURNS}-${MAX_DELEGATE_MAX_TURNS}）。默认按 profile 走（只读 24 / 写工 48）。查一个具体位置给 6-10 就够，扫一遍模块给 40+。预算耗尽会自动续跑，但续跑要重新盘点上下文，一次给够更划算。`

export const TIMEOUT_MS_TOOL_DESCRIPTION =
  `可选，本次派发的时间预算（毫秒，${MIN_DELEGATE_TIMEOUT_MS}-${MAX_DELEGATE_TIMEOUT_MS}）。默认按 profile 走。外层工具超时会跟着放宽，不必额外操心。`

/** 把工具入参里的预算字段转成 WorkOrder 的 budget 覆盖；都没给就返回 undefined。 */
export function toBudgetOverride(input: {
  maxTurns?: number
  timeoutMs?: number
}): Partial<WorkerBudget> | undefined {
  if (input.maxTurns === undefined && input.timeoutMs === undefined) return undefined
  return {
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }
}
