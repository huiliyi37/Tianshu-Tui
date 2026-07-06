/**
 * Transcript verbose 层 — 从会话消息构建含完整工具输出的详细转录。
 *
 * scrollback 里工具输出被截断成卡片摘要；pager 按 `v` 切换 verbose 层时，
 * 用本模块从 OaiMessage[]（会话真实历史）重建完整视图（CC Ctrl+O transcript 对标）。
 *
 * 与 worker-detail.ts 的 formatOaiMessages 的区别：不做 500 字符截断——
 * 工具结果保留全文（仅按 MAX_TOOL_RESULT_CHARS 护栏防极端超大输出撑爆 pager）。
 */

import type { OaiMessage } from '../api/oai-types.js'
import type { TranscriptMessage } from './scrollback-transcript.js'
import { parseScrollbackTranscript } from './scrollback-transcript.js'

/** 单条工具结果的字符护栏。完整输出为目标，但 100MB 级 cat 输出仍需截断保护。 */
const MAX_TOOL_RESULT_CHARS = 100_000

function guard(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated at ${MAX_TOOL_RESULT_CHARS} chars; full output in session jsonl)`
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  return JSON.stringify(content)
}

export interface VerboseTranscript {
  content: string
  messages: TranscriptMessage[]
}

/**
 * 从会话消息构建 verbose 转录。
 * system 消息跳过（体积大且与"回看对话"无关）；工具结果保留全文。
 */
export function buildVerboseTranscript(messages: readonly OaiMessage[]): VerboseTranscript {
  const lines: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        break
      case 'user': {
        lines.push('▌ you')
        lines.push(contentToText(msg.content))
        lines.push('')
        break
      }
      case 'assistant': {
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          lines.push(text)
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? '?'
            const args = tc.function?.arguments ?? '{}'
            lines.push(`● ${name} ${guard(args)}`)
          }
        }
        if (text || (msg.tool_calls && msg.tool_calls.length > 0)) lines.push('')
        break
      }
      case 'tool': {
        lines.push(`● tool result  ${msg.tool_call_id ?? ''}`)
        lines.push(guard(contentToText(msg.content)))
        lines.push('')
        break
      }
    }
  }
  const content = lines.join('\n')
  return { content, messages: parseScrollbackTranscript(content) }
}
