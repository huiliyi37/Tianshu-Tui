/**
 * memory tool — unified context memory: recall (search) + remember (persist).
 *
 * Merges the former recall + remember tools into a single tool with a
 * discriminated action field. Both operate on the same context claim store;
 * recall additionally searches .rivet/knowledge/ markdown files.
 */

import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimKind, ContextClaimScope } from '../context/claims.js'
import type { ToolDefinition } from '../api/types.js'
import type { MemoryKind } from '../memory/unified-memory.js'
import { getKnowledgeIndex } from '../memory/knowledge-index.js'
import { getRecallTracker } from '../memory/recall-efficacy.js'
import { renderGateFeedbackHint } from '../memory/gate-ledger.js'
import { readCommitFacts } from '../context/project-memory-writer.js'

// ── recall helpers ──

const DEFINITION: ToolDefinition = {
  name: 'memory',
  description: `Search and persist project knowledge across sessions.

### Actions
- recall: Hybrid search over the project knowledge base (structured entries + knowledge/*.md + playbook lessons). Supports kind/topic/source filters; returns only currently-valid entries by default (superseded knowledge needs includeHistory).
- remember: Persist a claim (decisions, observations, verification facts, failure patterns, or project rules). Session scope is immediate; project scope is queued and admitted by a session-end quality gate — a "pending quality gate" response means the claim IS recorded, do not retry.

### Claim kinds (for remember)
- decision — architectural or implementation decisions made
- file_observation — key observations about specific files
- verification_fact — test results or verified facts
- failure_pattern — bugs encountered and their root causes
- project_rule — patterns or conventions discovered in the codebase`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['recall', 'remember'], description: 'recall: search memory; remember: store a claim' },
      // recall params
      query: { type: 'string', description: 'Search keywords (hybrid BM25 + structured filters over the project knowledge base). Required for recall.' },
      kind: { type: 'string', enum: ['user_constraint', 'user_preference', 'decision', 'file_observation', 'verification_fact', 'failure_pattern', 'security_finding', 'worker_finding', 'project_rule'], description: 'Filter by claim kind' },
      topic: { type: 'string', description: 'Filter by topic scope (module/subject metadata) for recall' },
      source: { type: 'string', enum: ['playbook'], description: 'Restrict recall to a specific source. "playbook" returns only distilled playbook lessons.' },
      limit: { type: 'number', default: 5, description: 'Max results to return' },
      includeHistory: { type: 'boolean', default: false, description: 'Include superseded/expired knowledge entries in recall results (default: only current)' },
      includeCommitFacts: { type: 'boolean', default: false, description: 'Include historical commit facts in recall results (auto-enabled when query looks like a commit hash)' },
      // remember params
      text: { type: 'string', description: 'The claim text — be concise and specific (1-3 sentences). Required for remember.' },
      scope: { type: 'string', enum: ['session', 'project'], default: 'session', description: 'Lifetime: session (dies with session) or project (survives across sessions)' },
      confidence: { type: 'number', default: 0.9, description: 'Confidence 0-1. Use 0.9+ for verified facts, 0.5-0.7 for tentative observations' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
    },
    required: ['action'],
  },
}

export interface MemoryContext {
  sessionId: string
  getTurn: () => number
  cwd?: string
}

const REMEMBER_KINDS: ContextClaimKind[] = [
  'decision', 'file_observation', 'verification_fact',
  'failure_pattern', 'project_rule',
]

export function createMemoryTool(store: ContextClaimStore, ctx?: MemoryContext): Tool {
  return {
    definition: DEFINITION,

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action

      if (action === 'recall') {
        const query = typeof params.input.query === 'string' ? params.input.query.trim() : ''
        if (!query) return { content: 'Error: query is required for recall', isError: true }

        const kind = typeof params.input.kind === 'string' ? params.input.kind as MemoryKind : undefined
        const topic = typeof params.input.topic === 'string' ? params.input.topic.trim() : undefined
        const limit = typeof params.input.limit === 'number' ? params.input.limit : 5
        const includeHistory = params.input.includeHistory === true
        const source = params.input.source === 'playbook' ? 'playbook' as const : undefined

        const cwd = ctx?.cwd ?? process.cwd()

        // Hybrid 检索（Wave 3）：BM25 + 结构过滤 + 时间加权，统一覆盖
        // 知识条目、knowledge/*.md 分块与 playbook 教训。默认只返回 current 叶子。
        const hits = await getKnowledgeIndex(cwd).search(query, { limit, kind, topic, includeHistory, source })

        // commit_fact 侧车：显式请求或 query 形如 commit hash 时才查
        const looksLikeCommitHash = /\b[0-9a-f]{7,40}\b/i.test(query)
        const includeCommitFacts = params.input.includeCommitFacts === true || looksLikeCommitHash
        const commitFacts = includeCommitFacts
          ? readCommitFacts(cwd)
              .filter(e => e.text.toLowerCase().includes(query.toLowerCase())
                || query.toLowerCase().split(/\W+/).filter(t => t.length >= 3).some(t => e.text.toLowerCase().includes(t)))
              .slice(-limit)
          : []

        // 召回健康账本（Wave 3）：记录每次召回的空/命中，postSession 聚合落盘
        if (ctx?.sessionId) {
          getRecallTracker(ctx.sessionId).record(query, hits.map(h => ({
            text: h.text,
            id: h.entry?.id,
            gateAdmitted: h.entry?.source === 'essence-gate',
          })))
        }

        const lines: string[] = []

        // Wave 5（反馈闭环）：supersede 链结构告警（模型可见，不影响检索结果）
        const chainIssues = getKnowledgeIndex(cwd).chainIssues
        if (chainIssues.length > 0) {
          lines.push(`⚠ Knowledge chain integrity issues (${chainIssues.length}):`)
          for (const issue of chainIssues.slice(0, 3)) {
            lines.push(`  [${issue.kind}] ${issue.detail}`)
          }
          lines.push('')
        }

        // Wave 5（反馈闭环）：闸门健康度——账本指标越过阈值才产出，正常时零噪声
        const gateFeedback = renderGateFeedbackHint(cwd)
        if (gateFeedback) {
          lines.push(gateFeedback)
          lines.push('')
        }

        const entryHits = hits.filter(h => h.entry)
        const mdHits = hits.filter(h => h.file)
        if (entryHits.length > 0) {
          lines.push(`Knowledge entries (${entryHits.length}):`)
          for (const h of entryHits) {
            const e = h.entry!
            const meta: string[] = []
            if (e.topic) meta.push(`topic:${e.topic}`)
            if (e.evidence) meta.push(`evidence:${e.evidence.slice(0, 60)}`)
            if (e.sessionId) meta.push(`session:${e.sessionId.slice(0, 8)}`)
            if (e.supersededBy) meta.push(`superseded-by:${e.supersededBy}`)
            lines.push(`- [${e.kind}] ${e.text}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}`)
          }
        }
        if (mdHits.length > 0) {
          lines.push(`Knowledge files (${mdHits.length}):`)
          for (const h of mdHits) lines.push(`- ${h.file}: ${h.text.slice(0, 160).replace(/\n/g, ' ')}`)
        }
        const playbookHits = hits.filter(h => h.playbook)
        if (playbookHits.length > 0) {
          lines.push(`Playbook lessons (${playbookHits.length}):`)
          for (const h of playbookHits) lines.push(`- ${h.text.replace(/\n/g, ' ')}`)
        }
        if (commitFacts.length > 0) {
          lines.push(`Commit facts (${commitFacts.length}):`)
          for (const e of commitFacts) lines.push(`- ${e.text}`)
        }
        // 告警行（链校验/闸门健康）可能存在于零命中的响应里——仍要明确"没找到"
        if (hits.length === 0 && commitFacts.length === 0) {
          lines.push(`No memory found for "${query}".`)
        }
        return { content: lines.join('\n') }
      }

      // action === 'remember'
      const kind = typeof params.input.kind === 'string'
        ? (REMEMBER_KINDS.includes(params.input.kind as ContextClaimKind) ? params.input.kind as ContextClaimKind : null)
        : null
      if (!kind) {
        return { content: `Error: kind is required for remember. Must be one of: ${REMEMBER_KINDS.join(', ')}`, isError: true }
      }
      const text = typeof params.input.text === 'string' ? params.input.text.trim() : ''
      if (!text) return { content: 'Error: text is required for remember', isError: true }

      const scope: ContextClaimScope = params.input.scope === 'project' ? 'project' : 'session'
      const confidence = typeof params.input.confidence === 'number' ? Math.max(0, Math.min(1, params.input.confidence)) : 0.9
      const tags = Array.isArray(params.input.tags) ? params.input.tags.filter((t): t is string => typeof t === 'string') : undefined

      const turn = ctx?.getTurn() ?? 0
      const sessionId = ctx?.sessionId ?? 'unknown'

      const createdAt = Date.now()
      store.propose({
        kind,
        text,
        scope,
        confidence,
        fitness: confidence,
        source: { actor: 'assistant', eventId: `memory:${sessionId}:turn${turn}`, sessionId, turn },
        evidence: [],
        createdAt,
        tags: tags ?? [],
      })

      // Wave 2（知识重构）：project scope 不再直写 .rivet/knowledge/memory.jsonl。
      // 项目级持久化统一走 postSession essence-gate（LLM 准入闸）——claim store
      // 中 scope=project 的本会话条目由闸门收口裁决（loop-factory essenceGate 接线）。
      // 会话内该条目经 active-claims 通道立即可见，不受影响。
      if (scope === 'project') {
        return { content: `✅ Remembered: [${kind}] ${text}\n(project-scope persistence pending session-end quality gate)` }
      }

      return { content: `✅ Remembered: [${kind}] ${text}` }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

// ── Backward-compat: createRecallTool / createRememberTool ──
export const createRecallTool = createMemoryTool
export const createRememberTool = createMemoryTool
