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
}

/** Session-scoped: 从 delegate 结果抽取的声称路径集合 */
interface ClaimTracker {
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
        // Trim expired claims
        tracker.claims = tracker.claims.filter(c => c.expiresAtTurn > turn)
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

      if (!hasIndependentVerify) {
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
