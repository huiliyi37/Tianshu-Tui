import { z } from 'zod'
import type { DelegationRequest } from '../agent/coordinator.js'
import {
  assertStrongExpertDispatchable,
  recordExpertBench,
  resolveStrongExpert,
  type CriticalMomentKind,
  type StrongExpertId,
} from '../agent/strong-expert.js'
import { recordStrongExpertRouting, type StrongExpertRoutingStore } from '../agent/strong-expert-learning.js'
import { loadWorkerSession, expertBenchStorageKey } from '../agent/worker-session-persist.js'
import { MAX_EVIDENCE_CONSTRAINT_CHARS } from '../agent/work-order.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { formatUiContent, type DelegateTaskCoordinator } from './delegate-task.js'

const inputSchema = z.object({
  expert: z.enum(['root_cause', 'architecture', 'adversarial', 'design', 'surgeon']),
  objective: z.string().min(1),
  files: z.array(z.string()).optional(),
  evidence: z.array(z.string()).max(10).optional(),
  /** true = 复用该专家席的驻场 worker 会话（Expert Bench）。 */
  resume: z.boolean().optional(),
  /** 本次召唤对应的关键时刻（学习账本聚合键；缺省记 direct）。 */
  trigger: z.enum([
    'repeated-failure',
    'verification-broken',
    'gate-failed',
    'review-rejected',
    'scope-leak',
    'context-pressure',
    'convergence-plateau',
    'cross-module-blast',
  ]).optional(),
})

/** 专家驻场 order id 记忆（进程内）。键 = 项目隔离的驻场存储键（同 sidecar
 *  多会话/多项目池互不串），跨进程恢复由 worker-session-persist 承担。 */
const defaultResumeStore = new Map<string, string>()

export interface SummonExpertOptions {
  /** 写席 surgeon 显式开关；首批默认关闭。 */
  allowSurgeon?: boolean
  /** 测试可注入的进程内驻场记忆。键用 expertBenchStorageKey(benchId)。 */
  resumeStore?: Map<string, string>
  /** 测试可注入的跨进程驻场探测；生产默认读 worker-session-persist。 */
  benchStore?: { has: (benchId: string) => boolean }
  /** P2e 学习账本（MeridianDb）；缺省只做进程内统计不落盘。 */
  routingStore?: StrongExpertRoutingStore
}

function buildExpertConstraints(expert: string, evidence: string[]): string[] {
  const manifest = resolveStrongExpert(expert)
  if (!manifest) return []
  const packs: string[] = []
  if (manifest.methodPacks.capsules.length > 0) {
    packs.push(`方法论胶囊（需要时 recall_capsule 自取）：${manifest.methodPacks.capsules.join('、')}`)
  }
  if (manifest.methodPacks.generals.length > 0) {
    packs.push(`战绩账本（需要时 recall_general 自取）：${manifest.methodPacks.generals.join('、')}`)
  }
  const constraints = [`[strong-expert:${manifest.id}] ${manifest.description}`, ...packs]
  if (evidence.length > 0) {
    // 切片上限与 work-order.ts 证据级预算同一常量（单源）——两层各切一刀曾把
    // 4000 的证据包缩水到 ~370 字符（2026-09-02 审查修复）。
    constraints.push(`[evidence] 主控提供的证据线索（可核验、勿盲信）：\n${evidence.join('\n')}`.slice(0, MAX_EVIDENCE_CONSTRAINT_CHARS))
  }
  return constraints
}

export function createSummonExpertTool(
  coordinator: DelegateTaskCoordinator,
  opts: SummonExpertOptions = {},
): Tool {
  const resumeStore = opts.resumeStore ?? defaultResumeStore
  const benchStore = opts.benchStore ?? { has: id => loadWorkerSession(id) !== null }
  return {
    definition: {
      name: 'summon_expert',
      description:
        '召唤强专家代理（SEA）解决关键时刻问题。专家带独立工具面 + 星域方法论 + 可驻场上下文，模型档位不强制 strong。只读诊断席可常驻；写席 surgeon 首批未开放。',
      input_schema: {
        type: 'object',
        properties: {
          expert: { type: 'string', enum: ['root_cause', 'architecture', 'adversarial', 'design', 'surgeon'], description: '专家席 id：root_cause=根因诊断（只读），architecture=架构审查（只读），adversarial=对抗验证（只读），design=设计批评（只读），surgeon=修复写席（首批不可用）。' },
          objective: { type: 'string', description: '专家任务目标：症状、期望结论、返回证据要求。' },
          files: { type: 'array', items: { type: 'string' }, description: '可选文件范围（写席必填）。' },
          evidence: { type: 'array', items: { type: 'string' }, description: '主控采集的证据线索（错误输出/失败指纹/门禁失败项），最多 10 条。' },
          resume: { type: 'boolean', description: 'true = 复用该专家席的驻场会话（保留其历史上下文，降低重复冷启动）。' },
        },
        required: ['expert', 'objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return { content: `summon_expert 参数错误：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`, isError: true }
      }
      const manifest = resolveStrongExpert(parsed.data.expert)
      if (!manifest) {
        return { content: `未知专家席：${parsed.data.expert}`, isError: true }
      }
      try {
        assertStrongExpertDispatchable(manifest, opts.allowSurgeon ?? false)
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true }
      }

      const files = parsed.data.files ?? []
      if (manifest.write && files.length === 0) {
        return { content: `写席 ${manifest.id} 必须声明 files——专家只能在明确范围内动手。`, isError: true }
      }

      // 驻场 id = expert:<seaId>。deriveStableWorkOrderId 已认 expert: 前缀，
      // 所以每次召唤同一专家席都得到同一个 order id；worker-session-persist
      // 落盘到项目隔离的文件（expertBenchStorageKey）→ 跨进程 resume 命中同一
      // 份专家上下文，且不跨项目/跨会话串数据。
      const benchId = `expert:${manifest.id}`
      const storeKey = expertBenchStorageKey(benchId)
      const resumeHit = parsed.data.resume === true
        && (resumeStore.has(storeKey) || benchStore.has(benchId))
      const request: DelegationRequest = {
        parentTurnId: `${params.toolUseId ?? 'summon-expert'}:expert:${manifest.id}`,
        objective: parsed.data.objective,
        kind: manifest.kind,
        profile: manifest.baseProfile,
        authority: manifest.authority,
        scope: { files },
        constraints: buildExpertConstraints(manifest.id, parsed.data.evidence ?? []),
        extraAllowedTools: manifest.toolGrants,
        ...(manifest.modelPolicy.tierFloor ? { tierFloor: manifest.modelPolicy.tierFloor } : {}),
        budget: {
          ...(manifest.budget.maxTurns !== undefined ? { maxTurns: manifest.budget.maxTurns } : {}),
          ...(manifest.budget.timeoutMs !== undefined ? { timeoutMs: manifest.budget.timeoutMs } : {}),
          ...(manifest.budget.maxTokens !== undefined ? { maxTokens: manifest.budget.maxTokens } : {}),
        },
        ...(resumeHit ? { resumeWorkOrderId: benchId } : {}),
      }

      let dispatchedOrderId: string | undefined
      const run = await coordinator.delegate(request, params.abortSignal, (orderId) => {
        dispatchedOrderId = orderId
      })

      if (dispatchedOrderId) resumeStore.set(storeKey, benchId)
      const passed = run.results.filter(r => r.status === 'passed').length
      const total = run.results.length
      recordExpertBench(params.sessionId, manifest.id, { resumeHit, passed, total })
      if (opts.routingStore) {
        for (const result of run.results) {
          recordStrongExpertRouting(opts.routingStore, {
            sessionId: params.sessionId ?? 'unknown',
            expert: manifest.id,
            momentKind: parsed.data.trigger ?? 'direct',
            status: result.status === 'passed' ? 'passed' : result.status === 'blocked' ? 'blocked' : 'failed',
            model: run.selectedModel ?? result.model,
            costTokens: result.usage ? (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0) : undefined,
            // escalated 是基础设施升级事件不是能力失败，但不带 failureReason 会
            // 混进胜率分母——统一标注，学习侧按基础设施失败剔除。
            ...(result.failureReason ?? (result.status === 'escalated' ? 'escalated' : undefined)
              ? { failureReason: result.failureReason ?? 'escalated' }
              : {}),
          })
        }
      }
      return {
        content: `🧠 强专家代理 · ${manifest.label} · ${passed}/${total} 通过${resumeHit ? ` · 驻场续跑` : ''}\n${formatUiContent(run)}`,
        uiContent: `🧠 ${manifest.label} · ${passed}/${total}`,
        orchestration: {
          kind: 'expert',
          runId: params.toolUseId,
          expert: manifest.id,
          profile: manifest.baseProfile,
          authority: manifest.authority,
          methodPacks: manifest.methodPacks,
          momentKind: parsed.data.trigger ?? 'direct',
          resumeHit,
          model: run.selectedModel,
          status: run.status,
          passed,
          total,
        },
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: (toolParams) => {
      const id = (toolParams?.input as { expert?: string } | undefined)?.expert
      const manifest = id ? resolveStrongExpert(id) : null
      return (manifest?.budget.timeoutMs ?? 600_000) + 30_000
    },
  }
}
