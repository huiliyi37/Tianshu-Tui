/**
 * Worker Detail 内容构建器 — 为 `/tasks` Enter 提供可分页、可搜索的详情。
 *
 * 数据来源：
 * - liveView（FleetRegistry）→ profile、authority、status、elapsed、activityLog
 * - ~/.rivet/subagents/<workerId>.json（loadPersistedResult）→ result summary / changed files / artifacts / usage
 * - ~/.rivet/sessions/<slug>/worker-<id>.jsonl（SessionPersist.loadOai）→ 完整对话转录
 */

import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { loadPersistedResult } from '../agent/coordinator.js'
import type { FleetWorkerView } from './fleet-registry.js'
import type { TranscriptMessage } from './scrollback-transcript.js'
import { parseScrollbackTranscript } from './scrollback-transcript.js'
import type { OaiMessage } from '../api/oai-types.js'
import { shortOrderLabel } from '../tools/worker-activity-stream.js'

const MAX_CONTENT_CHARS = 500

function truncate(text: string, max = MAX_CONTENT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function formatTokens(usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_tokens?: number }): string {
  if (!usage) return '-'
  const parts: string[] = []
  if (usage.input_tokens !== undefined) parts.push(`in ${usage.input_tokens}`)
  if (usage.output_tokens !== undefined) parts.push(`out ${usage.output_tokens}`)
  if (usage.cache_read_input_tokens) parts.push(`cache ${usage.cache_read_input_tokens}`)
  if (usage.reasoning_tokens) parts.push(`reason ${usage.reasoning_tokens}`)
  return parts.join(' · ') || '-'
}

function formatOaiMessages(messages: OaiMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'system': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(`┌─ system`)
        lines.push(truncate(text))
        break
      }
      case 'user': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(`▌ you`)
        lines.push(truncate(text))
        break
      }
      case 'assistant': {
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          lines.push(truncate(text))
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? '?'
            const args = tc.function?.arguments ?? '{}'
            lines.push(`● ${name} ${truncate(args, 160)}`)
          }
        }
        break
      }
      case 'tool': {
        lines.push(`● tool result  ${msg.tool_call_id ?? ''}`)
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(truncate(text))
        break
      }
    }
  }
  return lines.join('\n')
}

export interface WorkerDetailContent {
  content: string
  title: string
  messages: TranscriptMessage[]
}

/**
 * 构建指定 worker 的详情内容。
 * @param workerId work order id（如 wo_team:T1）
 * @param cwd 当前项目目录，用于定位会话文件
 * @param liveView FleetRegistry 中的实时视图（可选，提供 profile/authority/activityLog）
 */
export function buildWorkerDetailContent(
  workerId: string,
  cwd: string,
  liveView?: FleetWorkerView,
): WorkerDetailContent {
  const shortLabel = liveView?.shortLabel ?? shortOrderLabel(workerId)
  const lines: string[] = []

  lines.push(`══ Worker ${shortLabel} ══`)
  lines.push(`id: ${workerId}`)
  if (liveView?.profile) lines.push(`profile: ${liveView.profile}`)
  if (liveView?.authority) lines.push(`authority: ${liveView.authority}`)
  const statusLineParts: string[] = []
  statusLineParts.push(`status: ${liveView?.status ?? 'unknown'}`)
  if (liveView?.elapsedMs !== undefined) {
    const sec = Math.floor(liveView.elapsedMs / 1000)
    statusLineParts.push(`elapsed: ${sec}s`)
  }
  lines.push(statusLineParts.join(' · '))

  // ── 活动日志 ──
  if (liveView?.activityLog && liveView.activityLog.length > 0) {
    lines.push('')
    lines.push('── Activity ──')
    for (const entry of liveView.activityLog) {
      lines.push(`  ${entry}`)
    }
  }

  // ── 持久化结果 ──
  const result = loadPersistedResult(workerId)
  if (result) {
    lines.push('')
    lines.push('── Result ──')
    lines.push(`status: ${result.status}`)
    if (result.model) lines.push(`model: ${result.model}`)
    if (result.provider) lines.push(`provider: ${result.provider}`)
    if (result.usage) lines.push(`usage: ${formatTokens(result.usage)}`)
    lines.push(`summary: ${truncate(result.summary)}`)
    if (result.changedFiles && result.changedFiles.length > 0) {
      lines.push('changed files:')
      for (const f of result.changedFiles.slice(0, 20)) {
        lines.push(`  · ${f}`)
      }
      if (result.changedFiles.length > 20) {
        lines.push(`  … +${result.changedFiles.length - 20} more`)
      }
    }
    if (result.artifacts && result.artifacts.length > 0) {
      lines.push('artifacts:')
      for (const a of result.artifacts) {
        lines.push(`  · [${a.kind}] ${a.title}`)
        lines.push(`    ${truncate(a.content, 200)}`)
      }
    }
    if (result.risks && result.risks.length > 0) {
      lines.push('risks:')
      for (const r of result.risks.slice(0, 10)) {
        lines.push(`  · ${r}`)
      }
    }
  }

  // ── 完整会话转录 ──
  const sessionId = `worker-${workerId.replace(/:/g, '-')}`
  const persist = new SessionPersist(sessionId, cwd)
  let transcriptText = ''
  try {
    const messages = persist.loadOai()
    transcriptText = formatOaiMessages(messages)
  } catch {
    transcriptText = '(worker transcript not available)'
  }

  if (transcriptText) {
    lines.push('')
    lines.push('── Transcript ──')
    lines.push(transcriptText)
  }

  const content = lines.join('\n')
  return {
    content,
    title: `Worker ${shortLabel}`,
    messages: parseScrollbackTranscript(content),
  }
}

/** 返回 worker 会话文件是否已落盘（用于 UI 判断是否可进入 detail）。 */
export function workerSessionExists(workerId: string, cwd: string): boolean {
  try {
    const sessionId = `worker-${workerId.replace(/:/g, '-')}`
    const persist = new SessionPersist(sessionId, cwd)
    return !!persist.getFilePath()
  } catch {
    return false
  }
}
