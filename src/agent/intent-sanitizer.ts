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
  '检查': 'review_audit',
  '排查': 'review_audit',
  '走查': 'review_audit',
  '盘点': 'review_audit',
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
 * 也支持序数词引用（"第一个""第二项""第3个"），解析为对应顺序的列表条目。
 */
export function resolveContextualIdentifier(
  userMessage: string,
  lastAssistantMessage?: string,
  taskList?: readonly TaskListItem[]
): ContextualTask[] {
  const resolved: ContextualTask[] = []

  // 0. 序数词引用解析（"第一个""第二项""第3个"）
  const ordinalRefs = extractOrdinalReferences(userMessage)
  if (ordinalRefs.length > 0) {
    for (const ord of ordinalRefs) {
      const item = resolveOrdinal(ord.index, lastAssistantMessage, taskList)
      if (item) {
        resolved.push({ identifier: `第${ord.index}项`, resolvedContent: item })
      }
    }
  }

  // 1. 找出用户消息中所有的编号（不区分大小写）
  const idRegex = /\b([PpTtSs]\d+|TASK-\d+|ISSUE-\d+|BUG-\d+)\b/g
  const matches = userMessage.match(idRegex)
  if (!matches && resolved.length === 0) return resolved
  if (!matches) return resolved

  const uniqueIds = [...new Set(matches.map(m => m.toUpperCase()))]
  const unresolved = new Set(uniqueIds)

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

// 中文数字 → 阿拉伯数字映射
const CN_NUM: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
}

/** 解析用户消息中的序数词引用，返回 (1-based) 索引列表 */
function extractOrdinalReferences(text: string): Array<{ raw: string; index: number }> {
  // 匹配 "第一个""第二项""第3个""第十条""第2步" 等
  // 来源文本片段: "做第一个" / "就做第二项" / "第3个" — intent-sanitizer.ts:resolveContextualIdentifier 调用方
  const regex = /第([一二三四五六七八九十]+|\d+)[个项条步]/g
  const results: Array<{ raw: string; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    const numStr = m[1]
    if (numStr === undefined) continue
    let index: number
    if (/^\d+$/.test(numStr)) {
      index = parseInt(numStr, 10)
    } else {
      index = parseChineseNumber(numStr)
    }
    if (index > 0) {
      results.push({ raw: m[0], index })
    }
  }
  return results
}

/** 解析中文数字字符串（支持 1-99，如 "十"→10, "十二"→12, "二十"→20） */
function parseChineseNumber(s: string): number {
  if (s === '十') return 10
  if (s.startsWith('十')) return 10 + (CN_NUM[s[1]!] ?? 0)
  if (s.endsWith('十')) return (CN_NUM[s[0]!] ?? 0) * 10
  if (s.includes('十')) {
    const parts = s.split('十')
    const tens = CN_NUM[parts[0]!] ?? 1
    const ones = CN_NUM[parts[1]!] ?? 0
    return tens * 10 + ones
  }
  return CN_NUM[s] ?? 0
}

/**
 * 从 lastAssistantMessage 的列表条目中按顺序取第 N 个（1-based）。
 * 先尝试解析为结构化列表（- / * / 1. 等开头），失败则回退到 taskList。
 */
function resolveOrdinal(
  index: number,
  lastAssistantMessage?: string,
  taskList?: readonly TaskListItem[]
): string | null {
  // 尝试从 lastAssistantMessage 提取列表条目
  if (lastAssistantMessage) {
    const items = extractListItems(lastAssistantMessage)
    if (items.length > 0 && index <= items.length) {
      return items[index - 1] ?? null
    }
  }
  // 回退到 taskList
  if (taskList && index <= taskList.length) {
    return taskList[index - 1]?.content ?? null
  }
  return null
}

/** 从文本中提取列表条目内容（支持 - / * / 数字. / ### 开头的行） */
function extractListItems(text: string): string[] {
  const lines = text.split('\n')
  const items: string[] = []
  // 匹配: "- xxx", "* xxx", "1. xxx", "### xxx" 等 markdown 列表格式
  // 来源文本片段: "- P1: 修复 loop.ts 内存泄露" / "1. 修复登录报错问题" — intent-sanitizer.ts 测试用例
  const listLineRegex = /^\s*(?:[-*•]|\d+[.)]\s|#+\s)(.+)/
  for (const line of lines) {
    const m = line.match(listLineRegex)
    if (m?.[1]) {
      const content = m[1].trim()
      // 过滤掉纯编号前缀（如 "P1: xxx" 取 "xxx"），保留有意义的内容
      const cleaned = content.replace(/^(?:\*?\*?[A-Za-z]*\d+\*?\*?\s*[:：\-\.]\s*)/, '').trim()
      if (cleaned.length > 2) {
        items.push(cleaned)
      }
    }
  }
  return items
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
 *
 * 高优先级类型（security_safety, bug_fix）一旦匹配，不应被单动词
 * 降级到次要位置——例如 "test the bug fix" 中动词 test 映射到
 * verification，但 bug_fix 的实际意图权重更高。
 */
// 不可被单动词降级的高优先级 taskKind 集合
const UNDEMOTEABLE_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'security_safety',
  'bug_fix',
])

export function disambiguateByVerb(
  candidates: IntentTaskKind[],
  verb: string
): IntentTaskKind[] {
  const preferred = VERB_INTENT_MAP[verb.toLowerCase()]

  // 如果候选中存在不可降级类型，优先保留它们在原顺序（按 KIND_RANK 排序后的顺序），
  // 不让动词将其他类型提升到它们之上
  const undemoteable = candidates.filter(c => UNDEMOTEABLE_KINDS.has(c))
  if (undemoteable.length > 0) {
    // 在不可降级类型中，如果动词映射到的类型恰在其中，可以调整它们之间的顺序
    if (preferred && undemoteable.includes(preferred)) {
      const rest = candidates.filter(c => c !== preferred)
      return [preferred, ...rest]
    }
    // 否则保持原顺序，动词不影响高优先级类型的排位
    return candidates
  }

  if (preferred && candidates.includes(preferred)) {
    return [preferred, ...candidates.filter(c => c !== preferred)]
  }
  return candidates
}
