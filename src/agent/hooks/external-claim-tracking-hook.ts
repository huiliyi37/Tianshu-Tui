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

/** 写工具名 */
const WRITE_TOOLS = new Set(['edit_file', 'hash_edit', 'write_file', 'apply_patch'])

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
    paths.add(canonicalizePath(match[1]))
  }
  return [...paths]
}

/**
 * 从写工具 input 中提取目标文件路径。
 */
function getWriteFilePath(tool: RuntimeToolEvent): string | null {
  const fp = tool.input?.file_path
  if (typeof fp === 'string') return fp
  // apply_patch uses 'path' or 'file'
  const p = tool.input?.path ?? tool.input?.file
  if (typeof p === 'string') return p as string
  return tool.target ?? null
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
        for (const filePath of claimedPaths) {
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
      if (!WRITE_TOOLS.has(tool.name)) return

      const writePath = getWriteFilePath(tool)
      if (!writePath) return

      // 查活跃声称中是否有匹配
      const activeClaims = tracker.claims.filter(c => c.expiresAtTurn > turn)
      const matchedClaim = activeClaims.find(c => c.filePath === writePath || writePath.endsWith(c.filePath) || c.filePath.endsWith(writePath))
      if (!matchedClaim) return

      // 检查 recentToolHistory：delegate 之后是否有 read/grep 核验过该路径
      const history = ctx.snapshot.recentToolHistory
      const delegateTurn = matchedClaim.turn

      // 看历史中 delegate 之后的核验操作
      // recentToolHistory 是滑动窗口（最近 ~5 条），如果 delegate 刚发生不久，
      // 窗口可能仍包含它。更可靠的检查：看窗口内是否有 read/grep 操作。
      const hasIndependentVerify = history.some(
        h => VERIFY_TOOLS.has(h.tool) || (h.tool === 'bash' && /\b(grep|cat|find|rg)\b/.test(h.target ?? '')),
      )

      if (!hasIndependentVerify) {
        deps.advisoryBus.submit({
          key: 'external-claim-unverified',
          priority: 0.56,
          category: 'discipline',
          content: `⚠ delegate 报告中提到了 ${writePath}，你正在编辑它，但中间没有独立核验（read_file/grep）。worker 报告的行号可能偏移或引用了过时文件状态。先用 read_file 或 grep 独立确认该路径的当前内容，再编辑。`,
          ttl: 1,
        })
      }
    },
  }

  return hook
}
