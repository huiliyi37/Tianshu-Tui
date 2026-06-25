/**
 * TDD Gate
 *
 * Injects a hint when the agent is in executing phase without having
 * touched any test files. Fires on every executing turn (not one-shot)
 * so the agent is continuously reminded until it writes a test.
 *
 * Consumed via the existing immune hint pipeline (_lastImmuneHint → formatImmuneContext),
 * so it does not pollute message history.
 */

import type { ImmuneContextHint } from './immune-context.js'
import type { DangerSignalKind } from './immune-types.js'

export interface TddGateInput {
  filesRead: Set<string>
  filesModified: Set<string>
  isActionable: boolean
}

const TEST_PATH_PATTERN = /(?:__tests__|\.test\.|\.spec\.|^test\/)/

function hasTestFile(paths: Set<string>): boolean {
  for (const p of paths) {
    if (TEST_PATH_PATTERN.test(p)) return true
  }
  return false
}

export function checkTddGate(input: TddGateInput): ImmuneContextHint | null {
  if (!input.isActionable) return null
  if (hasTestFile(input.filesRead) || hasTestFile(input.filesModified)) return null

  return {
    level: 'warning',
    signalKinds: ['tdd_violation' as DangerSignalKind],
    matchedMistakes: [],
    suggestion: `⚠ 你即将写/改实现代码但还没碰过测试文件。先写测试——Bugfix 必须先构造能复现原缺陷的 RED 测试（诊断循环），新功能必须先写测试定义行为契约。测试路径：src/**/__tests__/*.test.ts。跳过此步骤的交付将不被认可。`,
  }
}
