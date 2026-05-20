/**
 * 五色星辰色板
 *
 * 基于中国传统五色体系，对应五行、五方：
 * - 靛蓝（木·青）：天玑星君主色 — 青出于蓝，智慧之色
 * - 朱砂（火·赤）：玉衡星君主色 — 丹砂之赤，勇武之色
 * - 星金（土·黄）：活跃/高亮状态 — 星辰之光，中央之色
 * - 月白（金·白）：文字/辅助信息 — 月光色，清冷明亮
 * - 玄墨（水·黑）：深空底色/边框 — 北方之黑，深空色
 *
 * 北斗七星在北方 → 水 → 玄色（深蓝黑）
 */

// ─── 五色核心色值 ───────────────────────────────────────────────────

/** 靛蓝 — 木·青 — 天玑星君主色 */
export const INDIGO = '#4f46e5'

/** 朱砂 — 火·赤 — 玉衡星君主色 */
export const CINNABAR = '#dc2626'

/** 星金 — 土·黄 — 活跃/高亮状态 */
export const STAR_GOLD = '#f59e0b'

/** 月白 — 金·白 — 文字/辅助信息 */
export const MOONWHITE = '#e2e8f0'

/** 玄墨 — 水·黑 — 深空底色/边框 */
export const INK_BLACK = '#1e1b2e'

/** 远星灰 — 非活跃/次要信息 */
export const FAR_STAR_GRAY = '#64748b'

// ─── 星图面板专用色 ─────────────────────────────────────────────────

/** 面板边框色 */
export const PANEL_BORDER = '#334155'

/** 七星连线色 */
export const CONSTELLATION_LINE = '#475569'

/** 活跃星发光色 */
export const ACTIVE_STAR_GLOW = '#fbbf24'

/** 无线电消息色 */
export const RADIO_TEXT = '#22d3ee'

/** 当前 phase 中文标签色 */
export const PHASE_LABEL = '#e2e8f0'

// ─── 文武模式色映射 ─────────────────────────────────────────────────

/**
 * 文武模式对应色
 *
 * 天玑星君（文星）：靛蓝主色 — 智慧、沉静
 * 玉衡星君（武曲）：朱砂主色 — 勇武、刚烈
 */
export const MODE_COLORS = {
  wenxing: INDIGO,
  wuxing: CINNABAR,
} as const

// ─── 炼金五行色映射 ─────────────────────────────────────────────────

/**
 * 炼金阶段 → 五行色
 *
 * 用五行色替代无意义的灰/白/黄/红：
 * - nigredo（水·玄）：远星灰 — 玄冥初开
 * - albedo（金·白）：月白 — 月华初现
 * - citrinitas（土·黄）：星金 — 金光乍现
 * - rubedo（火·赤）：朱砂 — 炉火纯青
 */
export const ALCHEMY_WUXING_COLORS = {
  nigredo: FAR_STAR_GRAY,
  albedo: MOONWHITE,
  citrinitas: STAR_GOLD,
  rubedo: CINNABAR,
} as const

// ─── 星域配饰色 ─────────────────────────────────────────────────────

/**
 * 星域配饰色
 *
 * 破军：朱砂（勇武）
 * 天府：靛蓝（沉稳）
 * 天梁：星金（精确）
 */
export const DOMAIN_BADGE_COLORS = {
  pojun: CINNABAR,
  tianfu: INDIGO,
  tianliang: STAR_GOLD,
} as const

// ─── 256 色降级方案 ─────────────────────────────────────────────────

/**
 * 256 色终端降级方案
 *
 * 三级渲染降级策略（规格要求）：
 * 1. truecolor (24-bit) → 使用上面的 hex 色值
 * 2. 256色 → 使用下面的 ANSI 256 色名
 * 3. 16色 → 使用 chalk 基础色名
 *
 * 当 chalk.level < 3 时，使用此降级方案。
 */
export const FALLBACK_256 = {
  indigo: 'blue',
  cinnabar: 'red',
  starGold: 'yellow',
  moonwhite: 'white',
  inkBlack: 'black',
  farStarGray: 'gray',
  panelBorder: 'gray',
  constellationLine: 'gray',
  activeStarGlow: 'yellow',
  radioText: 'cyan',
  phaseLabel: 'white',
} as const

/**
 * 获取降级色值
 *
 * @param truecolor truecolor hex 值
 * @param fallbackKey 降级色的键名
 * @param colorLevel chalk.level
 * @returns 合适的色值
 */
export function getColorWithFallback(
  truecolor: string,
  fallbackKey: keyof typeof FALLBACK_256,
  colorLevel: number,
): string {
  return colorLevel >= 3 ? truecolor : FALLBACK_256[fallbackKey]
}
