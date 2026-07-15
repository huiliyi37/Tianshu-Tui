/**
 * Recall-efficacy hook — 召回健康账本的 postSession 落盘（Wave 3，知识重构）。
 *
 * memory 工具在会话中经模块级 tracker 记录每次召回；本 hook 在会话结束时
 * 聚合（召回次数/空召回率/引用率）落盘一行，并做连续空召回告警检测。
 */

import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import { getRecallTracker, releaseRecallTracker } from '../../memory/recall-efficacy.js'

export interface RecallEfficacyHookDeps {
  cwd: string
  sessionId: string
  /** 会话内 assistant 输出全文（引用率代理检测）。 */
  getAssistantText: () => string
}

export function createRecallEfficacyHook(deps: RecallEfficacyHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'recall-efficacy',
    run() {
      const tracker = getRecallTracker(deps.sessionId)
      try {
        if (tracker.recallCount > 0) {
          tracker.finalize(deps.cwd, deps.getAssistantText())
        }
      } finally {
        releaseRecallTracker(deps.sessionId)
      }
    },
  }
}
