export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

/**
 * max 档触发模式——需要完整推理链的深度场景。
 *
 * 原版只匹配 6 个英文架构词（design/architect/system/migration/strategy/rewrite），
 * 大量需要深度推理的场景被降级到 high。扩充覆盖：
 * - 架构/系统设计、全局重构/迁移/改写、策略/方案评估
 * - 安全/漏洞分析（security audit, vulnerability, exploit）
 * - 性能深度优化与根因追踪（optimize performance, root cause, diagnose, profile）
 * - 算法/复杂度/权衡、跨模块影响分析
 * - 计划/架构评审
 */
const MAX_PATTERNS = /\b(design|architect|system\s+design|refactor(\s+\w+){0,3}\s+(across|entire|whole)|migration|rewrite|strategy|evaluate\s+the\s+approach|trade.?off|security\s+(audit|review|analysis)|vulnerabilit(y|ies)|exploit|pen.?test|optimi[zs]e\s+(performance|throughput|latency)|benchmark|profile\s+the|bottleneck|root\s+cause|diagnose|trace\s+through|algorithm|time\s+complexity|space\s+complexity|impact\s+analysis|dependency\s+(graph|tree|map)|blast\s+radius|review\s+(the\s+)?(architecture|design|plan|approach))\b/i

/**
 * high 档触发模式——需要认真推理但不一定需要完整推理链。
 * 单文件重构、复杂 bug 修复、功能实现、缓存层设计等。
 */
const HIGH_PATTERNS = /\b(refactor|debug|fix(\s+\w+){0,2}\s+(across|multiple)|implement.*feature|race\s+condition|memory\s+leak|caching\s+layer|concurrency|deadlock|test\s+failure|integration\s+test|edge\s+case|fallback\s+strategy|配置|修复|实现|测试)\b/i

const SIMPLE_PATTERNS = /\b(what|explain|show|list|print|read|cat|describe|查看|显示)\b/i
const TRIVIAL_PATTERNS = /^\/(compact|clear|help|exit|model|theme|debug|verbose|sessions|resume|fork|rollback|undo|evidence|context|memory|mcp|scroll|cockpit|auto)/

const EFFORT_RANK: Record<ReasoningEffort, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4 }

/** 中文深度场景关键词——需要完整推理链。中间词距容错（.{0,12}）。 */
const CN_MAX_PATTERNS = /(设计|架构).{0,8}(方案|系统|模块|整体)|重构(整个|全部|所有)|深度分析|全面审查|根因.{0,4}(分析|排查)|排查.{0,10}根因|影响面分析|跨模块|评审.{0,10}(方案|架构|设计)|安全(审计|审查)|性能(优化|调优)|瓶颈(分析|定位)/

export function selectReasoningEffort(input: string, floor?: ReasoningEffort): ReasoningEffort {
  let effort: ReasoningEffort
  if (TRIVIAL_PATTERNS.test(input)) effort = 'off'
  else if (MAX_PATTERNS.test(input) || CN_MAX_PATTERNS.test(input)) effort = 'max'
  else if (HIGH_PATTERNS.test(input)) effort = 'high'
  else if (SIMPLE_PATTERNS.test(input)) effort = 'low'
  else effort = 'medium'

  if (floor && EFFORT_RANK[effort] < EFFORT_RANK[floor]) return floor
  return effort
}
