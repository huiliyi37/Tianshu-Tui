/**
 * post-commit-review-queue — 后台提交后审查的结果待投递队列
 *
 * deliver_task 的系统触发审查（auto / typecheck 升级 / goal-achieved L3）不再
 * 同步阻塞工具调用：审查在后台跑完后把结论推进本队列，由
 * post-commit-review-hook（postTool / preTurn 相位）排水并经 AdvisoryBus
 * 注入后续对话。显式 review_level 的审查仍走同步路径，不经过这里。
 *
 * 模块级单队列——deliver_task 与 hook 在同一进程内共享；与
 * POST_COMMIT_REVIEW_COOLDOWN_MS 的模块级去重同一模式。
 *
 * @module post-commit-review-queue
 */

export interface PostCommitReviewOutcomeEntry {
  /** 已格式化的结论行（与同步路径注入工具结果的行一致） */
  lines: string[]
  /** 审查结论 — rejected/verified/inconclusive/nudge，决定投递优先级 */
  verdict: string
  /** 审查层级（auto/L2/L3）——仅用于投递文案 */
  tier: string
  enqueuedAt: number
}

const queue: PostCommitReviewOutcomeEntry[] = []

export function enqueuePostCommitReviewOutcome(entry: Omit<PostCommitReviewOutcomeEntry, 'enqueuedAt'>): void {
  queue.push({ ...entry, enqueuedAt: Date.now() })
}

/** 排空队列并返回全部待投递结论（hook 消费端）。 */
export function consumePostCommitReviewOutcomes(): PostCommitReviewOutcomeEntry[] {
  return queue.splice(0)
}

/** Test-only: clear the module-level queue so it does not leak across cases. */
export function __resetPostCommitReviewQueue(): void {
  queue.length = 0
}
