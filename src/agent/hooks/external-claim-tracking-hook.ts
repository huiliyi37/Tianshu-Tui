/**
 * External-Claim Tracking Hook — postTool 检测 delegate 返回的外部声称路径，
 * 后续写操作对这些路径时若中间无独立核验（read_file/grep），注入 advisory。
 *
 * prompt 约束（`<rule name="external-source-verification">`）：
 *   worker 返回的 findings 是"待核验假设"……引用 worker 发现到具体文件前，
 *   必须用 read_file / grep 独立核验
 *
 * 设计：
 *   1. postTool 检测 delegate_task/delegate_batch 完成 → 从 resultContent 抽
 *      file:line 路径 → 记录到 session-scoped 声称集合（带 TTL 轮次）
 *   2. postTool 检测写操作（edit_file/hash_edit/write_file）→ 如果目标路径
 *      在声称集合中 → 查 recentToolHistory 看中间是否有 read/grep 核验过
 *      → 无核验 → submit advisory
 *
 * 复杂度低于原设计：不做 mtime oracle 查询（需要 sessionId 注入），改用
 * recentToolHistory 模式匹配（与 self-verify 同源），零额外依赖。
 *
 * 通道：AdvisoryBus.submit（ttl: 1），与 spec-verify-gate 近亲但分工不同：
 * spec-verify-gate 管"读诊断文档→直接动手"；这个管"delegate 报告→直接编辑"。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { WRITE_TOOL_NAMES, extractWriteFilePaths } from '../../tools/write-tool-helpers.js'

export interface ExternalClaimTrackingHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** 声称路径条目——delegate 报告中抽取的 file:line 路径 */
interface ClaimEntry {
  /** 相对路径（canonical 化后） */
  filePath: string
  /** 记录时的 turn 号 */
  turn: number
  /** TTL 轮次——超过后自动失效 */
  expiresAtTurn: number
  /** 本会话已对该路径独立核验（read/grep/verify-bash 目标命中）的 turn；
   *  undefined = 未核验。deliver 门禁与 Step 2 的第二判据来源。 */
  verifiedAt?: number
}

/** Session-scoped: 从 delegate 结果抽取的声称路径集合 */
export interface ClaimTracker {
  claims: ClaimEntry[]
}

/** delegate 类工具名 */
const DELEGATE_TOOLS = new Set(['delegate_task', 'delegate_batch'])

/** 核验类工具（read_file / grep / glob / lsp_*） */
const VERIFY_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'semantic_search',
  'lsp_goto_definition', 'lsp_find_references',
])

/** 声称 TTL（轮次）——delegate 后 N 轮内对相关路径的写操作需核验 */
const CLAIM_TTL_TURNS = 5

/**
 * 从 delegate 工具结果中抽取 file:line 路径。
 *
 * 正则来源：worker-prompts.ts:35 "Every finding must cite a specific file:line reference"
 * 匹配格式：`src/agent/foo.ts:123` 或 `src/tools/bar.ts:45:10`
 *   第一组：相对路径（至少含一个 /，扩展名 .ts/.tsx/.js/.jsx/.json/.md）
 *   冒号后：行号（数字）
 *
 * 不匹配绝对路径（/开头）或当前目录引用（./foo）。
 */
const FILE_LINE_RE = /(\b(?:src|test|tests|scripts|docs|config)\/[^\s:)]+\.(?:ts|tsx|js|jsx|json|md)):(\d+)/g

/**
 * Canonical 化文件路径——去掉行号后缀，统一为相对路径。
 * `src/agent/foo.ts:123` → `src/agent/foo.ts`
 */
function canonicalizePath(pathRef: string): string {
  return pathRef.replace(/:\d+.*$/, '')
}

/**
 * 从文本中抽取所有 file:line 路径引用，返回去重后的文件路径集合。
 */
export function extractClaimedPaths(content: string): string[] {
  const paths = new Set<string>()
  // Reset regex state
  FILE_LINE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_LINE_RE.exec(content)) !== null) {
    paths.add(canonicalizePath(match[1]!))
  }
  return [...paths]
}

/**
 * verify 类工具的目标文本——结构化 input 优先（path/file_path/file/pattern/
 * query/command），target 兜底。用于判定该工具是否命中某个声称路径。
 */
function verifyTargetOf(tool: RuntimeToolEvent): string {
  const input = (tool.input ?? {}) as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['path', 'file_path', 'file', 'pattern', 'query', 'command']) {
    const v = input[key]
    if (typeof v === 'string') parts.push(v)
  }
  if (tool.target) parts.push(tool.target)
  return parts.join(' ')
}

/**
 * 证据防火墙（Phase 2）：找出交付文本中引用了、但本会话未独立核验的声称路径。
 *
 * `[待核]` 标注行豁免——诚实降级为线索的行不参与引用抽取（与 Phase 1 诚实
 * 标注协议同语义）。tracker.claims 恒为活跃集（hook run() 开头 trim）。
 *
 * @returns 去重后的未核验声称路径列表；空 = 全部已核验或无引用。
 */
export function findUnverifiedClaimRefs(tracker: ClaimTracker, text: string): string[] {
  const scanText = text.split('\n').filter(l => !l.includes('[待核]')).join('\n')
  const refs = extractClaimedPaths(scanText)
  if (refs.length === 0) return []
  const unverified = new Set(
    tracker.claims.filter(c => c.verifiedAt === undefined).map(c => c.filePath),
  )
  return refs.filter(r => unverified.has(r))
}

export function createExternalClaimTrackingHook(
  deps: ExternalClaimTrackingHookDeps,
): PostToolRuntimeHook & { getClaimTracker: () => ClaimTracker; resetClaimTracker: () => void } {
  const tracker: ClaimTracker = { claims: [] }

  const hook: PostToolRuntimeHook & { getClaimTracker: () => ClaimTracker; resetClaimTracker: () => void } = {
    phase: 'postTool',
    name: 'external-claim-tracking',
    getClaimTracker() { return tracker },
    resetClaimTracker() { tracker.claims = [] },
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const { turn } = ctx.snapshot

      // ── Step 0: 活跃集维护 ────────────────────────────────────
      // trim 在每次 run 开头执行（原在 Step 1 内）——tracker.claims 恒为
      // 未过期集合，deliver 门禁（findUnverifiedClaimRefs）无需 turn 参数。
      tracker.claims = tracker.claims.filter(c => c.expiresAtTurn > turn)

      // ── Step 1: delegate 完成 → 抽取声称路径 ──────────────────
      if (DELEGATE_TOOLS.has(tool.name) && tool.success && tool.resultContent) {
        const claimedPaths = extractClaimedPaths(tool.resultContent)

        // 豁免：delegate 输入中指派 worker 改的文件路径——这些是主控明确
        // 要求 worker 改的，主控跟进编辑同一文件是正常协作，不是盲信。
        // 来源：文档缺口② 落地修正清单第 4 点 "delegate 任务本身指派 worker
        // 改某文件、主控随后跟进同一文件"
        const inputPaths = new Set<string>()
        const files = tool.input?.files
        if (Array.isArray(files)) {
          for (const f of files) {
            if (typeof f === 'string') inputPaths.add(canonicalizePath(f))
          }
        }
        // files param on delegate_task
        const inputFiles = tool.input?.input_files
        if (Array.isArray(inputFiles)) {
          for (const f of inputFiles) {
            if (typeof f === 'string') inputPaths.add(canonicalizePath(f))
          }
        }

        for (const filePath of claimedPaths) {
          if (inputPaths.has(filePath)) continue // 豁免：主控指派的路径
          tracker.claims.push({
            filePath,
            turn,
            expiresAtTurn: turn + CLAIM_TTL_TURNS,
          })
        }
        return
      }

      // ── Step 1.5: verify 类工具成功 → 命中活跃 claim → 标 verifiedAt ──
      // 独立于 recentToolHistory（5 条窗口）：deliver 距 delegate 可能几十个
      // 工具调用，窗口早滚没——核验状态必须由 tracker 自含（Phase 2 设计）。
      const isVerifyShapedBash = tool.name === 'bash'
        && /\b(grep|cat|rg|find|head|tail|sed)\b/.test(String((tool.input as Record<string, unknown> | undefined)?.command ?? ''))
      if ((VERIFY_TOOLS.has(tool.name) || isVerifyShapedBash) && tool.success) {
        const hay = verifyTargetOf(tool)
        if (hay) {
          tracker.claims = tracker.claims.map(c =>
            c.verifiedAt === undefined && hay.includes(c.filePath) ? { ...c, verifiedAt: turn } : c,
          )
        }
        return // verify 工具不会同时是 write/deliver
      }

      // ── Step 3: deliver_task 完成 → 引用未核验声称 → 软提醒 ──
      // 防火墙关闭时的兜底（设计文档"关闭时退化为 advisory，不是完全静默"）。
      // 硬拦时 deliver 返回 isError → tool.success=false（tool-execution.ts:687
      // success: !(result.is_error === true) 取反语义，已验证）→ 本分支不触发，
      // 软硬互斥天然成立。deliver 不是 write 工具——必须在 Step 2 的 write 检查
      // return 之前判定。
      if (tool.name === 'deliver_task' && tool.success) {
        const input = (tool.input ?? {}) as Record<string, unknown>
        const checklist = Array.isArray(input.checklist)
          ? (input.checklist as Array<{ item?: unknown }>).map(e => typeof e?.item === 'string' ? e.item : '').join('\n')
          : ''
        const text = `${typeof input.message === 'string' ? input.message : ''}\n${checklist}`
        const refs = findUnverifiedClaimRefs(tracker, text)
        if (refs.length > 0) {
          deps.advisoryBus.submit({
            key: 'external-claim-in-delivery',
            priority: 0.6,
            category: 'discipline',
            content: `⚠ 交付文本引用了 delegate 报告的 ${refs.join('、')}，但本会话没有对其独立核验（read_file/grep）。worker 的 file:line 是待核验假设——commit 前先核验，或将该条标注 [待核] 降级为线索。`,
            ttl: 1,
            expect: { kind: 'tool_appears', tools: [...VERIFY_TOOLS, 'bash'], targetIncludes: refs[0]!, withinTurns: 2 },
          })
        }
        return
      }

      // ── Step 2: 写操作 → 检查是否命中未核验声称 ────────────────
      if (!WRITE_TOOL_NAMES.has(tool.name)) return

      const writePaths = extractWriteFilePaths(tool.name, tool.input as Record<string, unknown> | undefined)
      if (writePaths.length === 0) return

      // 查活跃声称中是否有匹配
      const activeClaims = tracker.claims.filter(c => c.expiresAtTurn > turn)
      const matchedClaim = activeClaims.find(c =>
        writePaths.some(wp => c.filePath === wp || wp.endsWith(c.filePath) || c.filePath.endsWith(wp))
      )
      if (!matchedClaim) return

      // 检查 recentToolHistory：delegate 之后是否有 read/grep 核验过**该特定文件**
      // 不是"任意 verify 工具"——read_file src/foo.ts 不核验 delegate 报告的 src/bar.ts
      const history = ctx.snapshot.recentToolHistory
      const claimedPath = matchedClaim.filePath

      const hasIndependentVerify = history.some(h => {
        // verify 工具的 target 必须包含声称的文件路径
        const target = h.target ?? ''
        const pathMatches = target.includes(claimedPath) || claimedPath.includes(target)
        if (!pathMatches) return false

        if (VERIFY_TOOLS.has(h.tool)) return true
        if (h.tool === 'bash' && /\b(grep|cat|find|rg)\b/.test(target)) return true
        return false
      })

      // 第二判据：tracker 自含的 verifiedAt（Step 1.5 标记）——history 窗口滚出
      // 后仍能识别"已核验过"，少一次误报。
      if (!hasIndependentVerify && matchedClaim.verifiedAt === undefined) {
        deps.advisoryBus.submit({
          key: 'external-claim-unverified',
          priority: 0.56,
          category: 'discipline',
          content: `⚠ delegate 报告中提到了 ${claimedPath}，你正在编辑它，但中间没有独立核验（read_file/grep）。worker 报告的行号可能偏移或引用了过时文件状态。先用 read_file 或 grep 独立确认该路径的当前内容，再编辑。`,
          ttl: 1,
          // 谓词映射表（P1a）：external-claim → tool_appears(核验类, 目标=声称路径, 2 轮)
          expect: {
            kind: 'tool_appears',
            tools: [...VERIFY_TOOLS, 'bash'],
            targetIncludes: claimedPath,
            withinTurns: 2,
          },
        })
      }
    },
  }

  return hook
}
