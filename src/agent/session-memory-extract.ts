import type { OaiMessage } from '../api/oai-types.js'

export interface ExtractedMemory {
  kind: 'user_preference' | 'decision' | 'file_observation' | 'failure_pattern' | 'task_state'
  text: string
  source: 'user' | 'assistant' | 'tool'
  turnIndex: number
}

export interface ExtractSessionMemoryOptions {
  recentToolTargets?: string[]
}

const DECISION_MARKERS = /\b(?:decided|decision|chose|selected|opted|approach|solution|strategy)\b|\buse\b[\s\S]{0,80}\bbecause\b/i
const ERROR_MARKERS = /\b(?:Error|TypeError|ReferenceError|SyntaxError|failed|FAIL|ENOENT|ENOTDIR|ECONNREFUSED)\b/
const FILE_PATH_PATTERN = /(?:\/?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})\b/g
const PREFERENCE_MARKERS = /\b(?:always|never|prefer|should|must|don't|please|use|instead)\b/i
const TASK_STATE_MARKERS = /\b(?:todo|next|remaining|current|done|completed|pending)\b/i

function contentOf(message: OaiMessage): string {
  if (message.role === 'assistant') {
    return `${message.content ?? ''}\n${message.reasoning_content ?? ''}`.trim()
  }
  if (message.role === 'user' && Array.isArray(message.content)) {
    return message.content.filter(p => p.type === 'text').map(p => p.text).join('')
  }
  return message.content as string
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bas decided earlier,?\s*/g, '')
    .replace(/\bthe\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function decisionKey(text: string): string {
  const lower = normalizeForDedup(text)
  const mapMatch = /\bmap\b/.test(lower)
  if (mapMatch) return 'decision:map'
  return `decision:${lower.slice(0, 80)}`
}

function pushUnique(
  memories: ExtractedMemory[],
  seen: Set<string>,
  memory: ExtractedMemory,
): void {
  const key = memory.kind === 'decision'
    ? decisionKey(memory.text)
    : `${memory.kind}:${memory.source}:${normalizeForDedup(memory.text)}`
  if (seen.has(key)) return
  seen.add(key)
  memories.push(memory)
}

function extractDecisionSentence(content: string): string | null {
  const sentences = content.split(/(?<=[.!?。！？])\s+|\n+/).map(s => s.trim()).filter(Boolean)
  const sentence = sentences.find(s => DECISION_MARKERS.test(s) && s.length >= 12)
  return sentence?.slice(0, 300) ?? null
}

function extractErrorLine(content: string): string | null {
  const line = content.split('\n').find(l => ERROR_MARKERS.test(l)) ?? null
  return line?.trim().slice(0, 300) ?? null
}

export function extractSessionMemories(
  messages: OaiMessage[],
  options: ExtractSessionMemoryOptions = {},
): ExtractedMemory[] {
  if (messages.length === 0) return []

  const memories: ExtractedMemory[] = []
  const seen = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === 'system') continue

    const content = contentOf(message)
    if (content.length < 3) continue

    if (message.role === 'tool') {
      const files = content.match(FILE_PATH_PATTERN) ?? []
      for (const file of files) {
        pushUnique(memories, seen, {
          kind: 'file_observation',
          text: `Observed file path: ${file}`,
          source: 'tool',
          turnIndex: i,
        })
      }

      const errorLine = extractErrorLine(content)
      if (errorLine) {
        pushUnique(memories, seen, {
          kind: 'failure_pattern',
          text: errorLine,
          source: 'tool',
          turnIndex: i,
        })
      }
    }

    if (message.role === 'assistant') {
      const decision = extractDecisionSentence(content)
      if (decision) {
        pushUnique(memories, seen, {
          kind: 'decision',
          text: decision,
          source: 'assistant',
          turnIndex: i,
        })
      }

      if (TASK_STATE_MARKERS.test(content)) {
        const line = content.split('\n').find(l => TASK_STATE_MARKERS.test(l)) ?? content
        pushUnique(memories, seen, {
          kind: 'task_state',
          text: line.trim().slice(0, 300),
          source: 'assistant',
          turnIndex: i,
        })
      }
    }

    if (message.role === 'user' && PREFERENCE_MARKERS.test(content) && content.length >= 10) {
      pushUnique(memories, seen, {
        kind: 'user_preference',
        text: content.trim().slice(0, 300),
        source: 'user',
        turnIndex: i,
      })
    }
  }

  for (const target of options.recentToolTargets?.slice(-20) ?? []) {
    if (!FILE_PATH_PATTERN.test(target)) {
      FILE_PATH_PATTERN.lastIndex = 0
      continue
    }
    FILE_PATH_PATTERN.lastIndex = 0
    pushUnique(memories, seen, {
      kind: 'file_observation',
      text: `Recent tool target: ${target}`,
      source: 'tool',
      turnIndex: messages.length,
    })
  }

  return memories.slice(-20)
}

export function classifyMemoryEntry(
  text: string,
  source: 'user' | 'assistant' | 'tool',
): { kind: ExtractedMemory['kind'] } {
  FILE_PATH_PATTERN.lastIndex = 0
  if (source === 'user' && PREFERENCE_MARKERS.test(text)) return { kind: 'user_preference' }
  if (source === 'assistant' && DECISION_MARKERS.test(text)) return { kind: 'decision' }
  if (source === 'tool' && ERROR_MARKERS.test(text)) return { kind: 'failure_pattern' }
  if (source === 'tool' && FILE_PATH_PATTERN.test(text)) {
    FILE_PATH_PATTERN.lastIndex = 0
    return { kind: 'file_observation' }
  }
  FILE_PATH_PATTERN.lastIndex = 0
  return { kind: 'task_state' }
}
