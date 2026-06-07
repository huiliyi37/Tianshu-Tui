import type { IntentTaskKind } from './intent-retrieval-route.js'
import type { TaskListItem } from './session-state.js'

export interface SanitizeResult {
  sanitized: string        // 脱敏或富化后的文本（编号替换为占位符/带上下文信息的文本）
  strippedTokens: string[] // 被剥离的原始编号 token
  semanticVerb: string | null  // 提取的核心动词
}

export interface ContextualTask {
  identifier: string       // 如 P1, T2
  resolvedContent: string  // 上一轮回复中的具体任务内容，如 "修复 loop.ts 中的内存泄露"
}

// 常见编号和 JIRA 任务格式的正则
const DOC_ID_PATTERNS = [
  /\b[PpTtSs]\d{1,3}\b/g,           // P0, P1, T1, S2 等
  /\b(?:TASK|Task|task)-?\d+\b/g,    // TASK-123, task1
  /\b(?:ISSUE|Issue|issue)-?\d+\b/g, // ISSUE-456
  /\b(?:BUG|Bug|bug)-?\d+\b/g,      // BUG-789
  /\b(?:REQ|Req|req)-?\d+\b/g,      // REQ-101
  /\b#\d{1,6}\b/g,                    // #123 (issue 引用)
  /\b[A-Z]{2,5}-\d{1,5}\b/g,        // JIRA-style: PROJ-123
]

// 动词到意图类型的映射
const VERB_INTENT_MAP: Record<string, IntentTaskKind> = {
  // 查看/理解类 → code_explanation
  '看看': 'code_explanation',
  '查看': 'code_explanation',
  '分析': 'code_explanation',
  '解释': 'code_explanation',
  '理解': 'code_explanation',
  'explain': 'code_explanation',
  'describe': 'code_explanation',
  'walkthrough': 'code_explanation',
  'read': 'code_explanation',

  // 修复类 → bug_fix
  '修复': 'bug_fix',
  '解决': 'bug_fix',
  'fix': 'bug_fix',
  'solve': 'bug_fix',
  'resolve': 'bug_fix',
  '报错': 'bug_fix',
  '失败': 'bug_fix',
  '异常': 'bug_fix',
  '回归': 'bug_fix',
  'bug': 'bug_fix',
  'error': 'bug_fix',
  'fail': 'bug_fix',
  'failed': 'bug_fix',
  'crash': 'bug_fix',
  'broken': 'bug_fix',
  'regression': 'bug_fix',

  // 审查类 → review_audit
  '审查': 'review_audit',
  '审核': 'review_audit',
  'review': 'review_audit',
  'audit': 'review_audit',

  // 设计类 → architecture_design
  '设计': 'architecture_design',
  '规划': 'architecture_design',
  'design': 'architecture_design',
  '架构': 'architecture_design',
  'architecture': 'architecture_design',
  '选型': 'architecture_design',

  // 优化类 → performance_diagnosis
  '优化': 'performance_diagnosis',
  '加速': 'performance_diagnosis',
  'optimize': 'performance_diagnosis',
  '性能': 'performance_diagnosis',
  'oom': 'performance_diagnosis',
  '内存泄漏': 'performance_diagnosis',
  'memory leak': 'performance_diagnosis',

  // 重构类 → refactor
  '重构': 'refactor',
  '整理': 'refactor',
  'refactor': 'refactor',
  'migrate': 'refactor',
  '迁移': 'refactor',
  'cleanup': 'refactor',
  '拆分': 'refactor',

  // 验证类 → verification
  '验证': 'verification',
  '跑测试': 'verification',
  'verify': 'verification',
  'test': 'verification',
  'run test': 'verification',
  'check': 'verification',

  // 用法类 → usage_question
  '怎么用': 'usage_question',
  '如何': 'usage_question',
  'how': 'usage_question',
  '用法': 'usage_question',
  '配置': 'usage_question',
  'configure': 'usage_question',
  'api': 'usage_question',
  'command': 'usage_question',

  // 新功能类 → new_feature
  '新增': 'new_feature',
  '添加': 'new_feature',
  '支持': 'new_feature',
  '实现': 'new_feature',
  'feature': 'new_feature',
  'implement': 'new_feature',
}

/**
 * 从上一轮 Assistant 回复中解析用户提及的编号（如 P1/P2/T1 等）所指向的具体任务/内容。
 * 如果 lastAssistantMessage 中未找到，则从持久化的 taskList 中回溯查找（跨多轮支持）。
 */
export function resolveContextualIdentifier(
  userMessage: string,
  lastAssistantMessage?: string,
  taskList?: readonly TaskListItem[]
): ContextualTask[] {
  // 1. 找出用户消息中所有的编号（不区分大小写）
  const idRegex = /\b([PpTtSs]\d+|TASK-\d+|ISSUE-\d+|BUG-\d+)\b/g
  const matches = userMessage.match(idRegex)
  if (!matches) return []

  const uniqueIds = [...new Set(matches.map(m => m.toUpperCase()))]
  const unresolved = new Set(uniqueIds)
  const resolved: ContextualTask[] = []

  // 2. 优先从 lastAssistantMessage 中解析
  if (lastAssistantMessage) {
    const fromLast = extractFromText(uniqueIds, lastAssistantMessage)
    for (const item of fromLast) {
      resolved.push(item)
      unresolved.delete(item.identifier)
    }
  }

  // 3. 未解析的编号从持久化的 taskList 中回溯查找（跨多轮支持）
  if (unresolved.size > 0 && taskList) {
    for (const id of unresolved) {
      const item = taskList.find(t => t.id === id)
      if (item) {
        resolved.push({ identifier: id, resolvedContent: item.content })
        unresolved.delete(id)
      }
    }
  }

  return resolved
}

/** 从纯文本中按行匹配编号→内容映射 */
function extractFromText(ids: string[], text: string): ContextualTask[] {
  const lines = text.split('\n')
  const resolved: ContextualTask[] = []

  for (const id of ids) {
    const patterns = [
      new RegExp(`^[\\s*\\-\\d\\.\\#]*\\*?\\*?${id}\\*?\\*?[\\s\\:\\-\\.]+(.+)`, 'i'),
      new RegExp(`^\\s*\\*?\\*?${id}\\*?\\*?[\\s\\:\\-\\.]+(.+)`, 'i'),
      new RegExp(`\\b${id}\\b\\s*(?:-|=>|->|:|：)\\s*(.+)`, 'i'),
    ]

    let found = false
    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern)
        if (match?.[1]) {
          const content = match[1].trim()
          if (content.replace(/[`*_\\-\\s]/g, '').length > 3) {
            resolved.push({ identifier: id, resolvedContent: content })
            found = true
            break
          }
        }
      }
      if (found) break
    }
  }

  return resolved
}

/**
 * 将上一轮解析出的上下文任务内容来丰富/脱敏用户消息，以提供更强的意图分类信号。
 */
export function enrichUserMessageWithContext(
  userMessage: string,
  resolvedContexts: ContextualTask[]
): string {
  if (resolvedContexts.length === 0) return userMessage

  let enriched = userMessage
  for (const item of resolvedContexts) {
    // 替换为富上下文，例如将 "做 P1" 替换为 "做 P1 (上下文关联任务: 修复 loop.ts 中的内存泄露)"
    const regex = new RegExp(`\\b${item.identifier}\\b`, 'gi')
    enriched = enriched.replace(regex, `${item.identifier} (上下文关联任务: ${item.resolvedContent})`)
  }
  return enriched
}

/**
 * 文档编号脱敏 — 将 P0/P1/T1/TASK-123 等 token 替换为通用占位符，
 * 避免它们被 transformer attention 锁定导致意图偏移。
 */
export function sanitizeForIntentClassification(text: string): SanitizeResult {
  let sanitized = text
  const strippedTokens: string[] = []

  for (const pattern of DOC_ID_PATTERNS) {
    const matches = text.match(pattern)
    if (matches) {
      for (const m of matches) {
        if (!strippedTokens.includes(m)) {
          strippedTokens.push(m)
        }
      }
    }
    sanitized = sanitized.replace(pattern, '[REF]')
  }

  const semanticVerb = extractSemanticVerb(sanitized)

  return {
    sanitized,
    strippedTokens,
    semanticVerb
  }
}

/**
 * 核心动词提取 — 从用户消息中提取驱动意图的动词。
 */
export function extractSemanticVerb(text: string): string | null {
  const lowercase = text.toLowerCase()
  const keys = Object.keys(VERB_INTENT_MAP).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (lowercase.includes(key)) {
      return key
    }
  }
  return null
}

/**
 * 动词到 taskKind 的映射 — 当正则匹配产生多个候选时，
 * 用动词语义来决定主要 taskKind。
 */
export function disambiguateByVerb(
  candidates: IntentTaskKind[],
  verb: string
): IntentTaskKind[] {
  const preferred = VERB_INTENT_MAP[verb.toLowerCase()]
  if (preferred && candidates.includes(preferred)) {
    return [preferred, ...candidates.filter(c => c !== preferred)]
  }
  return candidates
}
