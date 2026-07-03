import { isSocialOrTrivial, type TaskContract } from '../context/task-contract.js'
import type { TaskListItem } from './session-state.js'
import {
  resolveContextualIdentifier,
  enrichUserMessageWithContext,
  sanitizeForIntentClassification,
  extractSemanticVerb,
  disambiguateByVerb,
} from './intent-sanitizer.js'

export type RetrievalSource = 'codebase' | 'git' | 'memory' | 'docs' | 'external' | 'tests'
export type RetrievalPriority = 'must' | 'should' | 'optional' | 'avoid'
export type IntentTaskKind =
  | 'bug_fix'
  | 'performance_diagnosis'
  | 'new_feature'
  | 'architecture_design'
  | 'refactor'
  | 'usage_question'
  | 'codebase_overview'
  | 'code_explanation'
  | 'review_audit'
  | 'verification'
  | 'security_safety'
  | 'social_idle'

export interface RetrievalDirection {
  source: RetrievalSource
  priority: RetrievalPriority
  query: string
  reason: string
}

export interface RetrievalRoute {
  taskKinds: IntentTaskKind[]
  directions: RetrievalDirection[]
  antiAnchorNote: string
  confidence: number
  fallbackUsed: boolean
  objectiveSummary?: string
}

export interface RetrievalRouteInput {
  userMessage: string
  lastAssistantMessage?: string
  /** 跨轮持久化的任务列表，用于多轮回溯解析编号引用 */
  taskList?: readonly TaskListItem[]
  taskContract?: TaskContract
  /** followUp mode: inherit previous turn's taskKinds when current message yields only default classification */
  inheritedTaskKinds?: IntentTaskKind[]
}

const SOURCES: readonly RetrievalSource[] = ['codebase', 'git', 'memory', 'docs', 'external', 'tests']
const PRIORITIES: readonly RetrievalPriority[] = ['must', 'should', 'optional', 'avoid']
const TASK_KINDS: readonly IntentTaskKind[] = [
  'bug_fix',
  'performance_diagnosis',
  'new_feature',
  'architecture_design',
  'refactor',
  'usage_question',
  'codebase_overview',
  'code_explanation',
  'review_audit',
  'verification',
  'security_safety',
  'social_idle',
]
const KIND_SET = new Set<string>(TASK_KINDS)
const SOURCE_SET = new Set<string>(SOURCES)
const PRIORITY_SET = new Set<string>(PRIORITIES)

const MAX_TASK_KINDS = 2
const MAX_DIRECTIONS = 6
const MAX_FIELD_LENGTH = 160
const MAX_NOTE_LENGTH = 180
const DEFAULT_ANTI_ANCHOR_NOTE = '用户关键词是入口，不是任务边界；先按任务类型补齐必查源。'
const PRIORITY_RANK: Record<RetrievalPriority, number> = { must: 0, should: 1, optional: 2, avoid: 3 }
const KIND_RANK: Record<IntentTaskKind, number> = {
  security_safety: 0,
  bug_fix: 1,
  performance_diagnosis: 2,
  review_audit: 3,
  refactor: 4,
  new_feature: 5,
  architecture_design: 6,
  verification: 7,
  usage_question: 8,
  codebase_overview: 9,
  code_explanation: 10,
  social_idle: 11,
}

export const TASK_KIND_BASELINES: Record<IntentTaskKind, RetrievalDirection[]> = {
  bug_fix: [
    { source: 'codebase', priority: 'must', query: '先查相关实现、错误路径和调用方，确认失败根因。', reason: 'bug 修复需要先定位实际失败点，而不是直接套用户给出的修法。' },
    { source: 'tests', priority: 'must', query: '查相关测试、复现方式和失败断言。', reason: '测试能确认问题是否复现以及修复是否覆盖。' },
    { source: 'memory', priority: 'should', query: '召回同类 bug、失败模式和既有修复经验。', reason: '历史记忆可避免重复踩坑。' },
    { source: 'git', priority: 'optional', query: '若像近期回归，查最近相关改动。', reason: '近期变更可能解释何时引入。' },
  ],
  performance_diagnosis: [
    { source: 'codebase', priority: 'must', query: '查热路径、循环、IO、缓存和资源使用点。', reason: '性能诊断必须先找到实际瓶颈路径。' },
    { source: 'git', priority: 'must', query: '查近期性能相关改动或依赖升级。', reason: '性能退化常由最近变更引入。' },
    { source: 'memory', priority: 'should', query: '召回历史性能、OOM、延迟和吞吐问题。', reason: '历史记录可提供已知瓶颈和天花板。' },
    { source: 'tests', priority: 'optional', query: '查 benchmark、压力测试或可复现实验。', reason: '性能判断需要测量支撑。' },
  ],
  new_feature: [
    { source: 'codebase', priority: 'must', query: '先查现有模式、相邻模块和调用方。', reason: '新功能应沿用项目既有结构。' },
    { source: 'docs', priority: 'should', query: '查项目文档、设计约定和已有规格。', reason: '文档可能定义边界和不做事项。' },
    { source: 'memory', priority: 'optional', query: '召回相关项目决策和约定。', reason: '记忆可补充未写入代码的设计取舍。' },
  ],
  architecture_design: [
    { source: 'codebase', priority: 'must', query: '查当前架构、模块边界和数据流。', reason: '架构设计必须以现状为约束。' },
    { source: 'memory', priority: 'must', query: '召回过往架构决策、项目规则和失败模式。', reason: '设计要继承已有取舍。' },
    { source: 'docs', priority: 'should', query: '查设计文档和相关计划。', reason: '文档通常记录代码中看不出的意图。' },
    { source: 'external', priority: 'optional', query: '必要时查外部资料或 API 规范。', reason: '选型问题可能依赖外部约束。' },
  ],
  refactor: [
    { source: 'codebase', priority: 'must', query: '查目标实现、调用方和依赖边界。', reason: '重构必须理解影响面。' },
    { source: 'git', priority: 'should', query: '查目标代码历史，理解为什么这么写。', reason: '历史能解释非显然约束。' },
    { source: 'tests', priority: 'must', query: '查相关测试和验证入口。', reason: '重构需要行为保持验证。' },
    { source: 'memory', priority: 'should', query: '召回设计意图和迁移经验。', reason: '记忆可避免破坏隐含约定。' },
  ],
  usage_question: [
    { source: 'docs', priority: 'must', query: '先查项目文档、README、配置说明或命令说明。', reason: '用法问题优先由文档回答。' },
    { source: 'external', priority: 'should', query: '若是外部 API/库，再查官方资料。', reason: '外部行为应以官方资料为准。' },
    { source: 'codebase', priority: 'optional', query: '必要时查实现或示例确认真实用法。', reason: '代码可校正文档缺失或过期。' },
    { source: 'git', priority: 'avoid', query: '默认不查 git，除非问题涉及近期变更或回归。', reason: '普通用法问题通常不需要历史。' },
  ],
  codebase_overview: [
    { source: 'codebase', priority: 'must', query: '先用 repo_map/inspect_project 建立模块地图，再看各模块入口与职责；不以单一入口文件代表全局。', reason: '概览需要覆盖面，单文件总结会漏掉主要子系统。' },
    { source: 'docs', priority: 'should', query: '查 README、AGENTS.md、架构文档和目录索引。', reason: '项目文档常有现成的架构说明与职责表。' },
    { source: 'memory', priority: 'optional', query: '召回项目结构与架构决策的既有记忆。', reason: '记忆可补充代码看不出的演进背景。' },
  ],
  code_explanation: [
    { source: 'codebase', priority: 'must', query: '查被解释对象、相邻实现和调用方。', reason: '解释代码必须基于真实实现。' },
    { source: 'memory', priority: 'optional', query: '必要时召回相关设计意图。', reason: '记忆可解释代码背后的取舍。' },
  ],
  review_audit: [
    { source: 'codebase', priority: 'must', query: '查实现、边界条件、调用方和影响面。', reason: '审查必须覆盖实际代码路径。' },
    { source: 'tests', priority: 'must', query: '查测试覆盖、缺口和验证入口。', reason: '风险判断需要验证证据。' },
    { source: 'git', priority: 'should', query: '查近期改动和责任范围。', reason: '审查需要理解变更背景。' },
    { source: 'memory', priority: 'should', query: '召回历史风险、P0/P1 和失败模式。', reason: '历史缺陷能提示审查重点。' },
  ],
  verification: [
    { source: 'tests', priority: 'must', query: '查并运行相关测试或验证命令。', reason: '验证任务以测试结果为核心证据。' },
    { source: 'git', priority: 'should', query: '查工作区状态和变更范围。', reason: '验证需要知道当前改了什么。' },
    { source: 'codebase', priority: 'optional', query: '必要时查实现确认测试覆盖对应行为。', reason: '代码可解释验证失败或覆盖缺口。' },
  ],
  security_safety: [
    { source: 'codebase', priority: 'must', query: '查权限、输入校验、路径、命令执行和 secret 流转。', reason: '安全审查必须基于实际攻击面。' },
    { source: 'git', priority: 'should', query: '查近期安全相关改动。', reason: '风险可能由最近改动引入。' },
    { source: 'tests', priority: 'must', query: '查安全边界测试和回归验证。', reason: '安全修复需要防回归。' },
    { source: 'memory', priority: 'should', query: '召回历史安全发现和项目规则。', reason: '历史发现能提示易错边界。' },
  ],
  social_idle: [],
}

export function buildHeuristicRetrievalRoute(input: RetrievalRouteInput): RetrievalRoute {
  let taskKinds = inferTaskKinds(input.userMessage, input.lastAssistantMessage, input.taskList)
  // followUp inheritance: when the current message yields only a non-specific classification
  // (default new_feature or social_idle), prefer the previous turn's task context.
  if (input.inheritedTaskKinds && input.inheritedTaskKinds.length > 0) {
    const isNonSpecific = taskKinds.length === 1 && (taskKinds[0] === 'new_feature' || taskKinds[0] === 'social_idle')
    if (isNonSpecific) {
      taskKinds = input.inheritedTaskKinds.slice(0, MAX_TASK_KINDS)
    }
  }
  const objectiveSummary = summarizeObjective(input)
  const directions = mergeDirections(taskKinds.flatMap(kind => baselineForKind(kind, input.taskContract)))
  return {
    taskKinds,
    directions,
    antiAnchorNote: DEFAULT_ANTI_ANCHOR_NOTE,
    confidence: confidenceFor(taskKinds),
    fallbackUsed: true,
    objectiveSummary,
  }
}

export function normalizeRetrievalRoute(raw: unknown, fallbackInput?: RetrievalRouteInput): RetrievalRoute {
  const obj = isRecord(raw) ? raw : {}
  const rawKinds = Array.isArray(obj.taskKinds) ? obj.taskKinds : []
  const taskKinds = rawKinds
    .filter((value): value is IntentTaskKind => typeof value === 'string' && KIND_SET.has(value))
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => KIND_RANK[a] - KIND_RANK[b])
    .slice(0, MAX_TASK_KINDS)

  if (taskKinds.length === 0) {
    return fallbackInput ? buildHeuristicRetrievalRoute(fallbackInput) : buildHeuristicRetrievalRoute({ userMessage: '' })
  }

  const rawDirections = Array.isArray(obj.directions) ? obj.directions : []
  const directionsFromRaw = rawDirections.flatMap(normalizeDirection)
  const baselineDirections = taskKinds.flatMap(kind => baselineForKind(kind, fallbackInput?.taskContract))
  const directions = mergeDirections([...baselineDirections, ...directionsFromRaw]).slice(0, MAX_DIRECTIONS)

  if (directions.length === 0 && !taskKinds.includes('social_idle')) {
    return fallbackInput ? buildHeuristicRetrievalRoute(fallbackInput) : buildHeuristicRetrievalRoute({ userMessage: '' })
  }

  return {
    taskKinds,
    directions,
    antiAnchorNote: truncate(cleanString(obj.antiAnchorNote) || DEFAULT_ANTI_ANCHOR_NOTE, MAX_NOTE_LENGTH),
    confidence: clampNumber(obj.confidence, 0, 1, 0.6),
    fallbackUsed: typeof obj.fallbackUsed === 'boolean' ? obj.fallbackUsed : false,
    objectiveSummary: truncate(cleanString(obj.objectiveSummary), MAX_FIELD_LENGTH) || undefined,
  }
}

/**
 * 低置信分类时注入的极简对齐提示——意图最模糊的场景恰恰最需要认知同步，
 * 沉默（不注入任何路由）会让主模型直接按关键词锚定展开。
 */
export const LOW_CONFIDENCE_INTENT_ADVISORY = [
  '<intent-retrieval-route advisory="true" scope="current-turn" confidence="low">',
  '  意图分类不确定：先用一句话向用户同步你对任务的理解（必要时问至多一个澄清问题），检索按实际问题自主展开，不受用户关键词锚定。',
  '</intent-retrieval-route>',
].join('\n')

export function renderIntentRetrievalRoute(route: RetrievalRoute): string {
  const normalized = normalizeRetrievalRoute(route)
  const attrs = [
    'advisory="true"',
    'scope="current-turn"',
    `confidence="${normalized.confidence.toFixed(2)}"`,
    `fallback-used="${normalized.fallbackUsed ? 'true' : 'false'}"`,
  ]
  const lines = [`<intent-retrieval-route ${attrs.join(' ')}>`]
  lines.push('  <authority>项目规则、工具权限、实际证据优先于本路由；必要时可查其它来源。</authority>')
  if (normalized.objectiveSummary) lines.push(`  <objective-summary>${escapeXml(normalized.objectiveSummary)}</objective-summary>`)
  lines.push(`  <task-kinds>${normalized.taskKinds.map(escapeXml).join(', ')}</task-kinds>`)
  lines.push(`  <anti-anchor-note>${escapeXml(normalized.antiAnchorNote)}</anti-anchor-note>`)
  lines.push('  <directions>')
  for (const direction of normalized.directions) {
    lines.push(`    <direction source="${direction.source}" priority="${direction.priority}">`)
    lines.push(`      <query>${escapeXml(direction.query)}</query>`)
    lines.push(`      <reason>${escapeXml(direction.reason)}</reason>`)
    lines.push('    </direction>')
  }
  lines.push('  </directions>')
  lines.push('</intent-retrieval-route>')
  return lines.join('\n')
}

/** Detect trivial / social inputs that should not trigger tool-driven retrieval.
 *  Delegates to the unified isSocialOrTrivial from task-contract.ts. */
function isTrivialInput(sanitized: string): boolean {
  return isSocialOrTrivial(sanitized)
}

function inferTaskKinds(userMessage: string, lastAssistantMessage?: string, taskList?: readonly TaskListItem[]): IntentTaskKind[] {
  // Step 1: 解析上一轮回复中的关联任务计划（如 P1/P2/T1 等），含持久化 taskList 回溯
  const resolvedContexts = resolveContextualIdentifier(userMessage, lastAssistantMessage, taskList)
  // Step 2: 将任务详情富化到用户输入中，为正则提供强意图信号
  const enriched = enrichUserMessageWithContext(userMessage, resolvedContexts)
  // Step 3: 对富化后的消息进行编号脱敏与词语净化，提取语义动词
  const { sanitized } = sanitizeForIntentClassification(enriched)
  const verb = extractSemanticVerb(sanitized)
  const text = sanitized.toLowerCase()

  const kinds: IntentTaskKind[] = []
  const add = (kind: IntentTaskKind) => {
    if (!kinds.includes(kind)) kinds.push(kind)
  }

  if (hasSecurityIntent(text)) add('security_safety')
  if (/(修复|报错|失败|异常|回归|bug|error|fail|failed|failure|exception|crash|broken|regression|重试|retry)/i.test(sanitized)) add('bug_fix')
  if (hasPerformanceIntent(text, sanitized)) add('performance_diagnosis')
  if (hasReviewIntent(sanitized)) add('review_audit')
  if (/(重构|迁移|拆分|整理|refactor|migrate|migration|cleanup|split)/i.test(sanitized)) add('refactor')
  if (/(新增|支持|实现功能|feature|add\s+support|implement)/i.test(sanitized)) add('new_feature')
  if (/(设计|架构|方案|选型|architecture|architect|design|strategy)/i.test(sanitized)) add('architecture_design')
  if (/(验证|跑测试|确认是否完成|verify|verification|test this|run tests)/i.test(sanitized)) add('verification')
  if (/(怎么用|如何用|配置|命令|api|usage|how\s+to|configure|command)/i.test(sanitized)) add('usage_question')
  if (hasOverviewIntent(sanitized)) add('codebase_overview')
  if (/(解释|看一下|分析|说明|explain|describe|walk through|read)/i.test(sanitized)) add('code_explanation')

  if (kinds.length === 0 && isTrivialInput(sanitized)) add('social_idle')
  if (kinds.length === 0) add('new_feature')
  
  // Step 4: 动词消歧 — 当多种匹配时，动词语义优先
  let result = kinds.sort((a, b) => KIND_RANK[a] - KIND_RANK[b]).slice(0, MAX_TASK_KINDS)
  if (result.length > 1 && verb) {
    result = disambiguateByVerb(result, verb)
  }
  return result
}

function hasPerformanceIntent(text: string, original: string): boolean {
  if (/慢慢|慢一点|slowly|take your time/i.test(original)) return false
  return /(性能|卡顿|延迟|吞吐|响应慢|很慢|太慢|耗时|oom|内存泄漏|performance|latency|throughput|slow|sluggish|memory leak)/i.test(text)
}

function hasSecurityIntent(text: string): boolean {
  const hasTokenOnly = /\btoken\b/i.test(text) && !/(泄露|secret|安全|权限|越权|路径穿越|命令执行|injection|leak|expose|permission|authz|security|traversal|rce)/i.test(text)
  if (hasTokenOnly) return false
  return /(权限|越权|安全|泄露|密钥|路径穿越|命令执行|token 泄露|secret|api key|security|permission|authz|path traversal|command injection|rce|leak|expose)/i.test(text)
}

function hasOverviewIntent(userMessage: string): boolean {
  return /(概览|整体架构|项目结构|全局\S{0,6}(了解|梳理)|(这个|该|本)项目\S{0,6}(干嘛|做什么|是什么)|overview|architecture\s+of|walk\s+me\s+through\s+the\s+(codebase|project|repo))/i.test(userMessage)
}

function hasReviewIntent(userMessage: string): boolean {
  return /(审查|审核|风险|检查|排查|走查|自查|盘点|有没有\s*(问题|缺陷|漏洞|遗漏|风险)|缺陷|遗漏|覆盖不全|不覆盖|blast\s*radius|review|audit|gap\s*analysis|missing\s+coverage)/i.test(userMessage)
}

function baselineForKind(kind: IntentTaskKind, contract?: TaskContract): RetrievalDirection[] {
  const base = TASK_KIND_BASELINES[kind]
  const mentioned = contract?.scope.mentionedFiles ?? []
  if (mentioned.length === 0) return base
  const files = mentioned.slice(0, 3).join(', ')
  return base.map(direction => {
    if (direction.source !== 'codebase' && direction.source !== 'tests') return direction
    return {
      ...direction,
      query: `先查提到文件及调用方/相关测试：${files}。${direction.query}`,
    }
  })
}

function mergeDirections(directions: RetrievalDirection[]): RetrievalDirection[] {
  const bySource = new Map<RetrievalSource, RetrievalDirection>()
  for (const direction of directions) {
    const current = bySource.get(direction.source)
    if (!current || PRIORITY_RANK[direction.priority] <= PRIORITY_RANK[current.priority]) {
      bySource.set(direction.source, {
        source: direction.source,
        priority: direction.priority,
        query: truncate(direction.query, MAX_FIELD_LENGTH),
        reason: truncate(direction.reason, MAX_FIELD_LENGTH),
      })
    }
  }
  return [...bySource.values()].sort((a, b) => {
    const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (priority !== 0) return priority
    return SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source)
  })
}

function normalizeDirection(raw: unknown): RetrievalDirection[] {
  if (!isRecord(raw)) return []
  const source = typeof raw.source === 'string' && SOURCE_SET.has(raw.source) ? raw.source as RetrievalSource : undefined
  const priority = typeof raw.priority === 'string' && PRIORITY_SET.has(raw.priority) ? raw.priority as RetrievalPriority : undefined
  if (!source || !priority) return []
  return [{
    source,
    priority,
    query: truncate(cleanString(raw.query) || defaultQueryForSource(source), MAX_FIELD_LENGTH),
    reason: truncate(cleanString(raw.reason) || '该信息源与当前任务类型相关。', MAX_FIELD_LENGTH),
  }]
}

const ASK_MARKER_RE = /(帮我|请|需要|检查|分析|为什么|怎么|如何|[？?]|吗)/

/**
 * 从多行消息中提取「真正的请求句」——用户常见结构是先铺背景、最后一句才是
 * 要求（认知对齐 Stage 0.1：不把意图提前收敛成第一行）。取最后一个含请求
 * 标记的行；单行或无标记时回退首行。
 */
export function extractAskLine(message: string): string {
  const lines = message.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length <= 1) return lines[0] ?? ''
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ASK_MARKER_RE.test(lines[i]!)) return lines[i]!
  }
  return lines[0]!
}

function summarizeObjective(input: RetrievalRouteInput): string | undefined {
  const firstLine = input.userMessage.split('\n')[0]?.trim() || ''
  const askLine = extractAskLine(input.userMessage)
  // 请求句与首行不同时优先请求句；否则保持原行为（contract objective 优先）
  const objective = askLine && askLine !== firstLine
    ? askLine
    : (input.taskContract?.objective || firstLine)
  return truncate(objective, MAX_FIELD_LENGTH) || undefined
}

function confidenceFor(kinds: IntentTaskKind[]): number {
  if (kinds.length === 0) return 0.4
  if (kinds.includes('social_idle')) return 0.3
  if (kinds.length === 1 && kinds[0] === 'new_feature') return 0.55
  return kinds.length > 1 ? 0.65 : 0.75
}

function defaultQueryForSource(source: RetrievalSource): string {
  switch (source) {
    case 'codebase': return '查相关代码、调用方和现有模式。'
    case 'git': return '查相关历史和当前变更。'
    case 'memory': return '召回相关项目记忆和历史经验。'
    case 'docs': return '查项目文档和规格。'
    case 'external': return '必要时查外部官方资料。'
    case 'tests': return '查相关测试和验证入口。'
  }
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function truncate(value: string, max: number): string {
  const cleaned = cleanString(value)
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
