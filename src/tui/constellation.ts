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

export function renderConstellation(activePhase: StarPhase): string[] {
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

export function renderConstellationCompact(activePhase: StarPhase): string {
  return STAR_ORDER.map(p => {
    const glyph = p === activePhase ? PHASE_GLYPHS[p] : '·'
    return `${glyph}${PHASE_SHORT_LABELS[p]}`
  }).join('─')
}

/**
 * 纵向七星渲染 — 用于侧边栏面板
 *
 * 七星纵向排列，活跃星高亮，用竖线连接。
 * 设计：北斗七星在北方，纵向排列如天梯。
 *
 * @param activePhase 当前活跃相位
 * @returns 纵向渲染的字符串数组
 */
export function renderConstellationVertical(activePhase: StarPhase): string[] {
  const lines: string[] = []

  for (let i = 0; i < STAR_ORDER.length; i++) {
    const phase = STAR_ORDER[i]!
    const isActive = phase === activePhase
    const glyph = isActive ? PHASE_GLYPHS[phase] : '·'
    const name = PHASE_SHORT_LABELS[phase]
    const label = isActive ? `◀${name}` : ` ${name}`

    // 星星行
    lines.push(`${glyph} ${label}`)

    // 连接线（最后一颗星不加）
    if (i < STAR_ORDER.length - 1) {
      lines.push(isActive ? '│' : '│')
    }
  }

  return lines
}

/**
 * 获取当前活跃星的索引
 *
 * @param activePhase 当前活跃相位
 * @returns 在 STAR_ORDER 中的索引
 */
export function getActiveStarIndex(activePhase: StarPhase): number {
  const idx = STAR_ORDER.indexOf(activePhase)
  return idx >= 0 ? idx : 0
}

export { STAR_ORDER }
