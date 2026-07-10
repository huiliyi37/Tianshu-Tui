import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { VerificationMetadata } from '../../tools/types.js'

/**
 * Self-Verify Hook — postTurn check that prevents the model from treating
 * surface-level reads (commit summaries, document abstracts, web_fetch
 * snippets) as ground truth.
 *
 * Pattern: model reads metadata/summaries → draws conclusions → next turn
 * builds on unverified conclusions → "一条路走到死".
 *
 * Scope note: the check reads `recentToolHistory`, a sliding window of the
 * last ~5 tool calls (see tool-history-recorder.ts) — NOT strictly "the last
 * turn". For heavy turns the window sits inside the current turn; for light
 * turns it spans the last few steps. Either way the question is the same:
 * "did the recent steps reach a conclusion without any ground-truth check?"
 *
 * Trigger: the recent steps used ONLY read/write-class tools with ZERO
 * ground-truth verification. Verification = run_tests / deliver_task / a bash
 * command that actually runs tests/typecheck/lint/build — a bare `bash cat doc`
 * does NOT count (that is itself just another surface read). On trigger, submits
 * a one-turn advisory asking the model to independently verify before continuing.
 *
 * The 【瑶光】tag is intentional: this is 瑶光's 反身之道 — turning "复现即证"
 * onto the model's own just-made conclusion. When the 瑶光 domain is active the
 * advisory is deduped by AdvisoryBus (the frozen base already carries that
 * discipline); under every other domain it speaks as an outside reminder star.
 *
 * NOT a cumulative metric like CCR P1 — fires on the specific pattern of
 * "concluded without verifying", once per occurrence, via TTL=1 advisory.
 */

// ─── Tool classification ───────────────────────────────────────

const READ_CLASS_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'web_fetch', 'web_search',
  'repo_map', 'repo_graph', 'inspect_project', 'semantic_search',
  'lsp_goto_definition', 'lsp_find_references', 'file_info',
  'recall', 'recall_capsule', 'git',
])

const WRITE_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch',
])

/** bash commands that actually establish ground truth (vs. `cat`/`ls` reads). */
export const VERIFY_BASH_RE = /\b(test|tsc|type-?check|lint|eslint|build|vitest|jest|pytest|mocha|cargo\s+(test|check|build)|go\s+test|npm\s+(run\s+)?(test|build|typecheck)|make\s+(test|check))\b/i

/** A tool call that produced independent ground-truth verification. */
export function isVerifyCall(h: { tool: string; target?: string }): boolean {
  if (h.tool === 'run_tests' || h.tool === 'deliver_task') return true
  if (h.tool === 'bash') return VERIFY_BASH_RE.test(h.target ?? '')
  return false
}

/** Read-class, including a non-verifying bash (cat/ls/echo are just reads). */
function isReadOrWriteCall(h: { tool: string; target?: string }): boolean {
  if (READ_CLASS_TOOLS.has(h.tool) || WRITE_TOOLS.has(h.tool)) return true
  if (h.tool === 'bash') return !isVerifyCall(h) // non-verify bash counts as a read
  return false
}

// ─── W5: 粗粒度"验证-改动错配"检测 ────────────────────────────────
// VerificationMetadata.scope 只有 'full' | 'targeted'，不带完整文件列表；
// 精确交集判定不可行（天权评审）。只检测明显错配：改动跨 3+ 模块，
// 但所有验证都是 targeted、无任何 full-scope 验证。

const SCOPE_MISMATCH_MODULE_THRESHOLD = 3

/** 粗粒度模块键：路径前两段（'src/agent/hooks/x.ts' → 'src/agent'）。 */
export function moduleOf(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  return segments.slice(0, Math.min(2, Math.max(1, segments.length - 1))).join('/')
}

export interface ScopeMismatch {
  mismatch: boolean
  moduleCount: number
}

/** 明显错配判定：改动跨 ≥3 模块 + 有验证但全是 targeted。 */
export function detectScopeMismatch(
  filesModified: ReadonlySet<string> | readonly string[],
  verifications: readonly VerificationMetadata[],
): ScopeMismatch {
  const files = [...filesModified]
  const modules = new Set(files.map(moduleOf))
  if (modules.size < SCOPE_MISMATCH_MODULE_THRESHOLD) return { mismatch: false, moduleCount: modules.size }
  if (verifications.length === 0) return { mismatch: false, moduleCount: modules.size } // 零验证由既有检测覆盖
  const hasFullScope = verifications.some(v => v.scope === 'full')
  return { mismatch: !hasFullScope, moduleCount: modules.size }
}

// ─── Hook ───────────────────────────────────────────────────────

export interface SelfVerifyHookDeps {
  /** Only `submit` is used — narrowed for testability (interface segregation). */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** W5: EvidenceTracker state getter for scope-mismatch detection.
   *  Absent → mismatch check disabled (unchanged behavior). */
  getEvidenceState?: () => { filesModified: Set<string>; verifications: VerificationMetadata[] }
}

export function createSelfVerifyHook(deps: SelfVerifyHookDeps): PostTurnRuntimeHook {
  // W5 nag 抑制：同一模块规模只提醒一次；改动继续扩到新模块才再次提醒。
  let lastMismatchModuleCount = 0
  return {
    phase: 'postTurn',
    name: 'self-verify',
    run(ctx: RuntimeHookContext) {
      const { recentToolHistory, turn } = ctx.snapshot
      if (recentToolHistory.length === 0) return
      if (turn < 2) return // don't nag on the very first turn

      // W5 粗粒度错配：改动跨多模块但验证全是 targeted 单点。与下方
      // 零验证检测互补——这里针对"验证了，但验证面配不上改动面"。
      if (deps.getEvidenceState) {
        const evidence = deps.getEvidenceState()
        const scope = detectScopeMismatch(evidence.filesModified, evidence.verifications)
        if (scope.mismatch && scope.moduleCount > lastMismatchModuleCount) {
          lastMismatchModuleCount = scope.moduleCount
          deps.advisoryBus.submit({
            key: 'self-verify-scope-mismatch',
            priority: 0.55,
            category: 'discipline',
            content: `【瑶光】本任务改动已跨 ${scope.moduleCount} 个模块，但已有验证全是 targeted 单点、没有任何 full-scope 验证。引入回归是最常见的交付失败——在收尾前跑一次全量（或逐模块）验证，别等交付门禁 RED。`,
            ttl: 1,
            observe: { turns: 1 },
          })
        }
      }

      const hasVerify = recentToolHistory.some(isVerifyCall)
      if (hasVerify) return // already verified — nothing to flag

      // No verification happened, and every recent step is a read/write
      // (incl. non-verifying bash). Unknown tools (todo_write, delegate_task…)
      // are not classified → stay conservative and don't fire.
      const allReadOrWrite = recentToolHistory.every(isReadOrWriteCall)
      if (!allReadOrWrite) return

      deps.advisoryBus.submit({
        key: 'self-verify',
        priority: 0.58,
        category: 'discipline',
        content: '【瑶光】最近几步你基于读取/编辑给出了结论，但没有独立验证（未运行测试或类型检查）。在继续推进之前，请先确认该结论有 ground truth 支撑——跑测试/读原文/用原输入自检，而非信任摘要或自己的判断。',
        ttl: 1,
        // P1a 核销 + Phase 2 挂起观察：模型常在下一轮自发验证——挂 1 个周期,
        // 窗口内 expect 已满足则自愈撤销（ICU 延迟确认降误报）,否则准时送达。
        expect: { kind: 'verify_attempted', withinTurns: 2 },
        observe: { turns: 1 },
      })
    },
  }
}
