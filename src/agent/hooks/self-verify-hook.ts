import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Self-Verify Hook — postTurn check that prevents the model from treating
 * surface-level reads (commit summaries, document abstracts, web_fetch
 * snippets) as ground truth.
 *
 * Pattern: model reads metadata/summaries → draws conclusions → next turn
 * builds on unverified conclusions → "一条路走到死".
 *
 * Trigger: last turn used ONLY read-class tools (read_file, web_fetch,
 * grep, etc.) with ZERO ground-truth verification (run_tests, bash with
 * typecheck/test, deliver_task). On trigger, submits a one-turn advisory
 * asking the model to independently verify its last conclusion before
 * continuing.
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

const VERIFY_TOOLS = new Set([
  'run_tests', 'bash', 'deliver_task',
])

const WRITE_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch',
])

// ─── Hook ───────────────────────────────────────────────────────

export interface SelfVerifyHookDeps {
  advisoryBus: AdvisoryBus
}

export function createSelfVerifyHook(deps: SelfVerifyHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'self-verify',
    run(ctx: RuntimeHookContext) {
      const { recentToolHistory, turn } = ctx.snapshot
      if (recentToolHistory.length === 0) return
      if (turn < 2) return // don't nag on the very first turn

      const hasVerify = recentToolHistory.some(h => VERIFY_TOOLS.has(h.tool))
      if (hasVerify) return // already verified — nothing to flag

      // All tools are either read or write class — no verification happened.
      // Fire advisory: the model's conclusions are unverified ground.
      const allReadOrWrite = recentToolHistory.every(
        h => READ_CLASS_TOOLS.has(h.tool) || WRITE_TOOLS.has(h.tool)
      )
      if (!allReadOrWrite) return

      deps.advisoryBus.submit({
        key: 'self-verify',
        priority: 0.58,
        category: 'discipline',
        content: '【瑶光】上一轮你基于读取/编辑给出了结论，但没有独立验证（未运行测试或类型检查）。在继续推进之前，请先确认上轮结论有 ground truth 支撑——跑测试/读原文/用原输入自检，而非信任摘要或自己的判断。',
        ttl: 1,
      })
    },
  }
}
