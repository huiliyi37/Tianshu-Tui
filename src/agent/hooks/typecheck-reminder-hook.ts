import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Typecheck-Reminder Hook — postTurn nudge that fills self-verify's blind spot.
 *
 * self-verify treats `run_tests` as "verified". But the test runner (tsx) and
 * the post-edit syntaxCheck both use esbuild, which only transpiles — it never
 * type-checks. So duplicate object keys, duplicate interface members, impossible
 * comparisons and dangling references from accidental deletions pass tests
 * green yet break `tsc`. This is exactly the failure mode that shipped a broken
 * typecheck while every test was green.
 *
 * Trigger (task-level, NOT the 5-entry window — see RuntimeHookSnapshot flags):
 *   touchedTsFiles            — a .ts/.tsx file was written this session
 *   ∧ !sawTypecheckThisTask   — no real `tsc`/typecheck has run since that edit
 *   ∧ run_tests in window     — the agent just verified via tests (a "done" moment)
 *
 * On trigger, submits a one-turn operational advisory. The authoritative
 * guarantee is the review-gate backstop (Component B); this is the cheap
 * per-turn reminder (Component C) that runs no tsc.
 */
export interface TypecheckReminderHookDeps {
  /** Only `submit` is used — narrowed for testability (interface segregation). */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

export function createTypecheckReminderHook(deps: TypecheckReminderHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'typecheck-reminder',
    run(ctx: RuntimeHookContext) {
      const { snapshot } = ctx
      if (!snapshot.touchedTsFiles) return
      if (snapshot.sawTypecheckThisTask) return

      const ranTests = snapshot.recentToolHistory.some(h => h.tool === 'run_tests')
      if (!ranTests) return

      deps.advisoryBus.submit({
        key: 'typecheck-reminder',
        priority: 0.6,
        category: 'typecheck',
        tier: 'operational',
        content: '【天梁】你改了 TS 文件、跑了测试,但没跑类型检查。esbuild/tsx 只转译不查类型——重复键/重复成员/悬空引用都不会报。交付前跑 `npm run typecheck`(或 `tsc --noEmit`)再声明完成。',
        ttl: 1,
      })
    },
  }
}
