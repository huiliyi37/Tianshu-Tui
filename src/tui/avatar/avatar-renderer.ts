import type { StarPhase } from '../../agent/star-event.js'
import type { AlchemyStage } from '../alchemy-bar.js'
import type { AvatarContext, AvatarMood, AvatarFrame, HeroId } from './types.js'
import { getFace, phaseToMood, phaseToMode } from './expressions.js'
import { buildFrame } from './frames.js'

/**
 * [未接线 / NOT WIRED] 星君头像渲染器（国风装饰）。
 * 主渲染路径（engine/app.ts）不 import avatar/*，仅测试引用。Claude Code 对标方向下
 * 不接入；保留为可选/遗留视觉资产，最终去留待产品决定。
 *
 * 星君渲染器：组合表情系统 + 帧模板 + 着色。纯函数，无 UI 依赖。
 */

// ─── Idle 情绪覆盖 ──────────────────────────────────────────────────

/**
 * 空闲时间情绪覆盖
 *
 * 设计原则（来自 Clippy 三级渐进 idle）：
 * - 0-30秒：保持当前情绪
 * - 30-60秒：升级为搜索（四处张望）
 * - 60秒+：升级为困惑（打盹/百思不解）
 * - 首次渲染：致意（初出茅庐）
 *
 * 只覆盖 calm 情绪，不干扰其他状态。
 *
 * @param mood 当前情绪
 * @param tick 动画帧计数器（首次渲染 = 1）
 * @param idleSeconds 空闲秒数
 */
export function idleMoodOverride(
  mood: AvatarMood,
  tick: number,
  idleSeconds: number,
): AvatarMood {
  // 首次渲染：致意（tick === 1 表示第一次渲染帧）
  if (tick === 1 && idleSeconds === 0) return 'greeting'
  // 只覆盖 calm 情绪
  if (mood !== 'calm') return mood
  // 空闲时间升级
  if (idleSeconds >= 60) return 'confused'
  if (idleSeconds >= 30) return 'searching'
  return mood
}

// ─── 炼金阶段情绪映射 ──────────────────────────────────────────────

/**
 * 炼金阶段对情绪的影响
 *
 * nigredo（玄冥初开）：保持原情绪
 * albedo（月华初现）：如果还是 calm，升级为 searching
 * citrinitas（金光乍现）：如果还是 calm，升级为 focused
 * rubedo（炉火纯青）：如果还是 calm，升级为 satisfied
 */
function alchemyMoodOverride(
  mood: AvatarMood,
  alchemy: AlchemyStage,
): AvatarMood {
  if (mood !== 'calm') return mood
  switch (alchemy) {
    case 'nigredo': return 'calm'
    case 'albedo': return 'searching'
    case 'citrinitas': return 'focused'
    case 'rubedo': return 'satisfied'
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * 渲染完整的星君帧
 *
 * 渲染流水线：
 * 1. phaseToMood() → 基础情绪
 * 2. alchemyMoodOverride() → 炼金阶段情绪覆盖
 * 3. idleMoodOverride() → 空闲时间情绪覆盖
 * 4. getFace() → kaomoji 面部（含眨眼）
 * 5. phaseToMode() → 文/武模式
 * 6. buildFrame() → 完整帧
 *
 * @param ctx 渲染上下文
 * @returns AvatarFrame + 元数据
 */
export function renderAvatar(ctx: AvatarContext): AvatarFrame & {
  phase: StarPhase
  mode: ReturnType<typeof phaseToMode>
  mood: AvatarMood
  hero: HeroId
} {
  // 1. 基础情绪
  let mood = phaseToMood(ctx.phase, ctx.isStuck, ctx.isTestFailing > 0)
  // 2. 炼金阶段覆盖
  mood = alchemyMoodOverride(mood, ctx.alchemy)
  // 3. 空闲时间覆盖
  mood = idleMoodOverride(mood, ctx.tick, ctx.idleSeconds)

  // 4. 获取面部
  const face = getFace(mood, ctx.tick)
  // 5. 获取模式
  const mode = phaseToMode(ctx.phase)
  // 6. 构建帧（传递 hero 参数，工程预留）
  const frame = buildFrame(mode, face, ctx.phase, ctx.domain, ctx.hero ?? null)

  return {
    ...frame,
    phase: ctx.phase,
    mode,
    mood,
    hero: ctx.hero ?? null,
  }
}
