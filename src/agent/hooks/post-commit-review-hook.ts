/**
 * post-commit-review-hook — 后台提交后审查结论的投递端
 *
 * deliver_task 把系统触发的提交后审查（auto / typecheck 升级 / goal L3）分离到
 * 后台执行（见 post-commit-review-queue），本 hook 在 preTurn / postTool 双相
 * 排水队列，把审查结论经 AdvisoryBus 注入对话——审查是 advisory，提交早已落地，
 * 结论晚到一两轮可接受，但不能同步阻塞主循环 180s+。
 *
 * 投递策略：
 * - rejected / escalated → operational + immediate（发现真问题，尽快让主控看到）
 * - inconclusive → operational（审查没跑成，主控该知道变更未被审查）
 * - verified / nudge → informational（低价值确认，填空即可）
 *
 * @module hooks/post-commit-review-hook
 */

import type { PreTurnRuntimeHook, PostToolRuntimeHook } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { consumePostCommitReviewOutcomes } from '../post-commit-review-queue.js'

export interface PostCommitReviewHookOptions {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

let submitSeq = 0

function drain(bus: Pick<AdvisoryBus, 'submit'>): void {
  for (const entry of consumePostCommitReviewOutcomes()) {
    const urgent = entry.verdict === 'rejected'
    const inconclusive = entry.verdict === 'inconclusive'
    bus.submit({
      // 每条结论独立投递——同一轮多个 commit 的审查结论不能互相去重覆盖。
      key: `post-commit-review:${entry.enqueuedAt}:${submitSeq++}`,
      priority: urgent ? 0.75 : inconclusive ? 0.55 : 0.3,
      category: 'discipline',
      tier: urgent || inconclusive ? 'operational' : 'informational',
      content: entry.lines.join('\n'),
      ttl: 2,
      ...(urgent ? { immediate: true } : {}),
    })
  }
}

/** preTurn 相：审查在轮间完成时，下一轮开始前投递。 */
export function createPostCommitReviewPreTurnHook(options: PostCommitReviewHookOptions): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'post-commit-review',
    run() {
      drain(options.advisoryBus)
    },
  }
}

/** postTool 相：主控还在连续跑工具（长 turn）时也能及时投递，不用等下一轮。 */
export function createPostCommitReviewPostToolHook(options: PostCommitReviewHookOptions): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'post-commit-review',
    run() {
      drain(options.advisoryBus)
    },
  }
}
