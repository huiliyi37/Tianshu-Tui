/**
 * [未接线 / NOT WIRED] ASCII 北斗工作流图（国风装饰）。生产 Starmap overlay 使用
 * format/overlay.ts 的 renderStarmap()，本模块仅测试引用。Claude Code 对标方向下
 * 不接入主路径；保留为可选/遗留视觉资产，最终去留待产品决定。
 */
import { PHASE_SHORT_LABELS, PHASE_GLYPHS, type StarPhase } from '../agent/star-event.js'

const STAR_ORDER: StarPhase[] = [
  'tianshu-planning',
  'tianxuan-locating',
  'tianji-decomposing',
  'tianquan-contracting',
  'yuheng-implementing',
  'kaiyang-testing',
  'yaoguang-delivering',
]

function starLabel(phase: StarPhase, active: StarPhase): string {
  const name = PHASE_SHORT_LABELS[phase]
  return phase === active ? `[${name}]` : ` ${name} `
}

export function renderStarmapConstellation(activePhase: StarPhase): string[] {
  const s = (p: StarPhase) => starLabel(p, activePhase)
  const g = (p: StarPhase) => activePhase === p ? PHASE_GLYPHS[p] : '·'

  return [
    `  ${g('tianshu-planning')}${s('tianshu-planning')}──${g('tianxuan-locating')}${s('tianxuan-locating')}──${g('tianji-decomposing')}${s('tianji-decomposing')}──${g('tianquan-contracting')}${s('tianquan-contracting')}`,
    `                                                │`,
    `                                          ${g('yuheng-implementing')}${s('yuheng-implementing')}`,
    `                                                │`,
    `                                    ${g('kaiyang-testing')}${s('kaiyang-testing')}──${g('yaoguang-delivering')}${s('yaoguang-delivering')}`,
  ]
}

export function renderStarmapConstellationCompact(activePhase: StarPhase): string {
  return STAR_ORDER.map(p => {
    const glyph = p === activePhase ? PHASE_GLYPHS[p] : '·'
    return `${glyph}${PHASE_SHORT_LABELS[p]}`
  }).join('─')
}
