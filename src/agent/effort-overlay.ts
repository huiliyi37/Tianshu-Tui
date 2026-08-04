/**
 * 工具族 effort overlay + 与 routeRoutineEffort 的合成。
 *
 * 只读/检索工具族倾向更低 effort（省思考 token）；写改 / 编排 / 规划抬高。
 * 与 Phase 2A 例行降档合成时取 **min**（更保守的那一档）——成本优先，
 * 且从不单独升档超过 strategy 给出的基线。
 */

import type { ReasoningEffort } from './auto-reasoning.js'
import { getToolFamily, type ToolFamily } from '../tui/tool-family.js'

const ORDER: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

/** 工具族 → 建议 effort 上限（overlay 天花板）。 */
export const TOOL_FAMILY_EFFORT_CAP: Record<ToolFamily, ReasoningEffort> = {
  read: 'low',
  find: 'low',
  write: 'medium',
  run: 'high',
  other: 'medium',
}

export function effortRank(effort: ReasoningEffort): number {
  const idx = ORDER.indexOf(effort)
  return idx < 0 ? 2 : idx
}

export function minEffort(a: ReasoningEffort, b: ReasoningEffort): ReasoningEffort {
  return effortRank(a) <= effortRank(b) ? a : b
}

/**
 * 最近工具历史 → overlay 建议。空历史返回 undefined（不参与合成）。
 * 取最近若干次工具中 **最高** 的族天花板（有写/跑就抬，不全是读就不降过头）。
 */
export function toolFamilyEffortOverlay(
  recentTools: ReadonlyArray<string>,
  lookback = 6,
): ReasoningEffort | undefined {
  if (recentTools.length === 0) return undefined
  const slice = recentTools.slice(-lookback)
  let max: ReasoningEffort | undefined
  for (const name of slice) {
    const family = getToolFamily(name).family
    const cap = TOOL_FAMILY_EFFORT_CAP[family]
    if (max === undefined || effortRank(cap) > effortRank(max)) max = cap
  }
  return max
}

/**
 * 合成规则：base（strategy）∩ overlay（工具族天花板）∩ routed（例行降档）→ min。
 * overlay 缺席时忽略该支。
 */
export function composeEffortWithOverlay(
  base: ReasoningEffort,
  routed: ReasoningEffort,
  overlay: ReasoningEffort | undefined,
): ReasoningEffort {
  let out = minEffort(base, routed)
  if (overlay !== undefined) out = minEffort(out, overlay)
  return out
}
