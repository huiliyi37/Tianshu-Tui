/**
 * 会话结束巩固（session consolidation）：会话结束后生成一份「我们做了什么」的
 * 摘要 + 提取可复用做法（procedure），写入长期记忆供后续召回。
 *
 * 与 auto-capture 分工：auto-capture 是操作后**即时**捕获单条重要操作；本模块
 * 是会话末**整体**纵览——回答「上一次会话干了什么 / 有什么可复用套路」。两者
 * 都只写 LTM，不触碰 prompt；召回/STM 负责后续注入。
 *
 * 缓存纪律：只写 `.rivet/knowledge/memory.jsonl`；LLM 不可用/超时 fail-closed。
 */

import { appendMemoryEntry, type MemoryKind, type MemorySource } from './unified-memory.js'
import { scrubMemoryText } from './memory-scrub.js'

export interface ConsolidationInput {
  sessionId?: string
  /** 会话转录（截断后）。 */
  transcript: string
  /** 会话目标/任务 objective。 */
  objective?: string | null
}

export interface Procedure {
  name: string
  whenToUse: string
  steps: string[]
}

export interface ConsolidationOutput {
  /** 3-6 句会话摘要（topic=session-summary）。 */
  summary: string
  /** 可复用做法条目（topic=procedure）。 */
  procedures: Procedure[]
}

const SUMMARY_KIND: MemoryKind = 'finding'
const PROCEDURE_KIND: MemoryKind = 'reusable_design_pattern'

/** 拉出一段可读的会话文本（user + assistant，封顶字符）。 */
export function renderTranscriptText(input: ConsolidationInput, maxChars = 12_000): string {
  return input.transcript.trim().slice(0, maxChars)
}

/** 巩固 prompt：让模型生成会话摘要 + 可复用做法。 */
export function buildConsolidationPrompt(input: ConsolidationInput): string {
  const lines: string[] = []
  lines.push('你是编码智能体的会话整理器。下面是一段会话转录。请输出两样东西：')
  lines.push('1. 一段 3-6 句的会话摘要（任务、做了什么、结果、关键文件/决定）。')
  lines.push('2. 可复用的做法列表（procedure）——本会话里值得下次照做的固定套路/流程。')
  lines.push('   每条做法给 name（简短）、whenToUse（何时用）、steps（有序步骤数组）。')
  lines.push('   没有可复用的做法就返回空数组。')
  lines.push('')
  if (input.objective) lines.push(`目标：${String(input.objective).slice(0, 300)}`)
  lines.push('')
  lines.push('转录：')
  lines.push(renderTranscriptText(input))
  lines.push('')
  lines.push('只返回一个 JSON 对象（无 markdown 围栏）：')
  lines.push('{"summary":"...","procedures":[{"name":"...","whenToUse":"...","steps":["step1","step2"]}]}')
  return lines.join('\n')
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

/** 解析模型输出。结构性意外返回 null（fail-closed）。 */
export function parseConsolidationOutput(raw: string): ConsolidationOutput | null {
  const jsonText = extractJson(raw)
  if (!jsonText) return null
  let parsed: unknown
  try { parsed = JSON.parse(jsonText) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  const summary = typeof p.summary === 'string' ? p.summary.trim() : ''
  const procedures: Procedure[] = []
  if (Array.isArray(p.procedures)) {
    for (const item of p.procedures) {
      if (typeof item !== 'object' || item === null) continue
      const proc = item as Record<string, unknown>
      const name = typeof proc.name === 'string' ? proc.name.trim() : ''
      if (!name) continue
      const whenToUse = typeof proc.whenToUse === 'string' ? proc.whenToUse.trim() : ''
      const steps = Array.isArray(proc.steps)
        ? proc.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
      procedures.push({ name, whenToUse, steps })
    }
  }
  return { summary, procedures }
}

/** 写回 LTM（默认 source='consolidation'；backfill 管道传 'backfill' 区分来源）。
 *  返回写入条数（summary + procedures）。 */
export function applyConsolidation(
  cwd: string,
  sessionId: string | undefined,
  output: ConsolidationOutput,
  source: MemorySource = 'consolidation',
): number {
  let written = 0
  if (output.summary.length >= 20) {
    const text = scrubMemoryText(output.summary)
    if (text) {
      try {
        appendMemoryEntry(cwd, {
          text: text.slice(0, 600),
          kind: SUMMARY_KIND,
          confidence: 0.75,
          source,
          status: 'observed',
          tags: ['consolidation', 'session-summary'],
          sessionId,
          topic: 'session-summary',
        })
        written++
      } catch { /* LTM write must never break caller */ }
    }
  }
  for (const procedure of output.procedures.slice(0, 3)) {
    const body = `${procedure.name}：${procedure.whenToUse}\n步骤：${procedure.steps.join(' → ')}`
    if (body.length < 20) continue
    const text = scrubMemoryText(body)
    if (!text) continue
    try {
      appendMemoryEntry(cwd, {
        text: text.slice(0, 500),
        kind: PROCEDURE_KIND,
        confidence: 0.7,
        source,
        status: 'observed',
        tags: ['consolidation', 'procedure'],
        sessionId,
        topic: 'procedure',
      })
      written++
    } catch { /* ignore */ }
  }
  return written
}

/** 巩固默认开启（env 可关）。 */
export function consolidationEnabled(value = process.env.RIVET_MEMORY_CONSOLIDATION): boolean {
  const v = value?.trim().toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false')
}
