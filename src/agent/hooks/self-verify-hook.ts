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
const VERIFY_BASH_RE = /\b(test|tsc|type-?check|lint|eslint|build|vitest|jest|pytest|mocha|cargo\s+(test|check|build)|go\s+test|npm\s+(run\s+)?(test|build|typecheck)|make\s+(test|check))\b/i

/** A tool call that produced independent ground-truth verification. */
function isVerifyCall(h: { tool: string; target?: string }): boolean {
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

// ─── Hook ───────────────────────────────────────────────────────

export interface SelfVerifyHookDeps {
  /** Only `submit` is used — narrowed for testability (interface segregation). */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

export function createSelfVerifyHook(deps: SelfVerifyHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'self-verify',
    run(ctx: RuntimeHookContext) {
      const { recentToolHistory, turn } = ctx.snapshot
      if (recentToolHistory.length === 0) return
      if (turn < 2) return // don't nag on the very first turn

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
      })
    },
  }
}
