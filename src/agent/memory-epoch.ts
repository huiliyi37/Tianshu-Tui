/**
 * Memory epoch reset — 跨会话学习库的一次性版本化清理。
 *
 * 背景（2026-07-06 用户数据包取证）：多条跨会话"学习"通道曾把垃圾持久化，
 * 且各自带自增强/复读回路，升级后旧数据继续毒害新版本：
 *   - .rivet/playbook.jsonl：错误转储级"教训"（deliver_task 报文原样入库、
 *     context 字段 merge 滚雪球）+ useCount 自增强，已默认停用（RIVET_PLAYBOOK）
 *   - meridian.db mistake_entries：Resolution 存原始工具参数 JSON 截断
 *     （200 字符拦腰切断），跨会话 warmup 加载后教模型复读死锚点
 *   - .rivet/recovery-journal.jsonl：陈旧 mutation 记录，未 ack 的旧条目
 *     会在无关会话的 deliver_task 里触发误导性警告
 *   - .rivet/knowledge/advisory-efficacy.jsonl：advisory 效能遥测旧账
 *
 * 机制：每个项目在 <rivetHome>/state/memory-epoch/<projectSlug>.json 记录
 * 已清理到的 epoch。启动时 epoch 落后 → 清空上述存量 → 写标记。首次安装
 * 无旧数据，清理为空操作，只落标记。未来再发现存量中毒数据时 bump
 * CURRENT_MEMORY_EPOCH 即可让全体用户在下次启动时再清一轮。
 *
 * 标记放用户级 rivetHome 而非项目 .rivet/：playbook.jsonl 属于可提交的
 * promoted 文件，标记混进项目目录会污染用户仓库。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { stateDir, projectSlug } from '../config/paths.js'

/** Bump 这个号触发下一轮全量清理（并在上面的 docstring 里补记原因）。 */
export const CURRENT_MEMORY_EPOCH = 1

/** 相对 <cwd> 的待清理文件清单（epoch 1，2026-07-06 取证认定的中毒存量）。 */
const LEGACY_FILES = [
  '.rivet/playbook.jsonl',
  '.rivet/recovery-journal.jsonl',
  '.rivet/knowledge/advisory-efficacy.jsonl',
] as const

interface EpochMarker {
  epoch: number
  resetAt: string
}

export function memoryEpochMarkerPath(cwd: string, markerBase?: string): string {
  return join(markerBase ?? stateDir(), 'memory-epoch', `${projectSlug(cwd)}.json`)
}

function readMarkerEpoch(path: string): number {
  if (!existsSync(path)) return 0
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EpochMarker>
    return typeof parsed.epoch === 'number' ? parsed.epoch : 0
  } catch {
    return 0 // 损坏标记按未清理处理——清理幂等，重跑无害
  }
}

export interface MemoryEpochResetOptions {
  /** 覆盖标记目录（测试注入临时目录用）。 */
  markerBase?: string
  /** meridian.db 的 mistake_entries 清理回调（bootstrap 传 db.clearMistakeEntries）。 */
  clearMistakeEntries?: () => void
}

export interface MemoryEpochResetResult {
  skipped: boolean
  epoch: number
  /** 实际删除/清理成功的目标（相对路径或 'meridian.db:mistake_entries'）。 */
  cleared: string[]
}

/**
 * 启动时调用：当前项目的记忆 epoch 落后于 CURRENT_MEMORY_EPOCH 时清空
 * 存量学习数据并写标记。所有删除各自容错——单个失败不影响其余，也绝不
 * 阻塞启动。
 */
export function resetLegacyMemoryIfNeeded(
  cwd: string,
  options: MemoryEpochResetOptions = {},
): MemoryEpochResetResult {
  const markerPath = memoryEpochMarkerPath(cwd, options.markerBase)
  if (readMarkerEpoch(markerPath) >= CURRENT_MEMORY_EPOCH) {
    return { skipped: true, epoch: CURRENT_MEMORY_EPOCH, cleared: [] }
  }

  const cleared: string[] = []
  for (const rel of LEGACY_FILES) {
    const abs = join(cwd, rel)
    if (!existsSync(abs)) continue
    try {
      rmSync(abs)
      cleared.push(rel)
    } catch { /* 单文件删除失败（占用/权限）不影响其余清理 */ }
  }

  if (options.clearMistakeEntries) {
    try {
      options.clearMistakeEntries()
      cleared.push('meridian.db:mistake_entries')
    } catch { /* better-sqlite3 缺失或 DB 损坏——跳过，文件清理照常 */ }
  }

  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    const marker: EpochMarker = { epoch: CURRENT_MEMORY_EPOCH, resetAt: new Date().toISOString() }
    writeFileSync(markerPath, JSON.stringify(marker) + '\n', 'utf-8')
  } catch { /* 标记写失败 → 下次启动重清一遍，幂等无害 */ }

  return { skipped: false, epoch: CURRENT_MEMORY_EPOCH, cleared }
}
