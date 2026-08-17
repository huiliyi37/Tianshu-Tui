/**
 * T9 格式化函数 — 首屏欢迎（概念 D「星阁」定稿：圆角框 + 北斗刊头 + 单列正文）。
 *
 * 渲染结构（10 行）：
 *   ╭─ 天枢  T I Ā N S H Ū  Code ───────────────────────────── v2.28.0 ─╮
 *   │ ✦────────∙─────✦────✧──────✧──────────────────────────────       │
 *   │ ╰─✧────✧─╯                                                       │
 *   │                                                                  │
 *   │ deepseek-v4 · ◎high · auto-safe                                  │
 *   │ ~/app/deepseek-tui/opencode-tui · #7281                          │
 *   │                                                                  │
 *   │ /init 生成项目说明   /domain 切换星域   /help 全部命令   ctrl+p 命令面板   │
 *   │ ⏜ /handoff 上下文 50%–70% 时交接给新会话                          │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *
 * 设计纪律：
 * - **北斗占两行，不压成一行。** 单行只是把星点当刻度，斗身四边形与斗柄折点
 *   全丢了；两行让斗身作为勺子挂在刊头线下，「斗 + 柄」的轮廓才立得住。
 *   顶行 = 斗身上边（天枢–天权）接斗柄，尾部续线兼作刊头分隔。
 * - **亮度编码真视星等**：✦ 天枢 1.79 / 玉衡 1.77（实心），✧ 天璇 2.37 /
 *   天玑 2.44 / 开阳 2.23 / 瑶光 1.86（空心），∙ 天权 3.31（微点）。
 *   列距按真实天区的水平投影配比。品牌星 ✦ 在这里回到本义——天枢就是最亮星。
 * - **字形宽度必须恒定**：`★`(U+2605) 与 `·`(U+00B7) 是 East-Asian Ambiguous，
 *   CJK 终端按 2 列渲染，会让右边线随终端参差。选用的 ✦ ✧ ∙ 三档在 narrow /
 *   wide / full 三档下恒 1 列，星图在任何终端都逐列对齐。
 * - **单一 accent**：只有最亮档带品牌色，其余走 muted / dim / pulseQuiet 明度阶梯。
 * - **框宽与输入框逐列咬合**：几何取自 `box-chars.ts`，与 `app.ts` 的输入框
 *   同一公式同一构造，两个框上下叠放时左右边线必须对齐。
 * - 行数纪律：框体 9 行 + 首尾各一空行 = 11 行；矮终端 / 恢复会话 / 窄终端
 *   走 compact 单行降级。
 */

import { homedir } from 'node:os'
import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth, ambiguousWideEnabled } from '../width.js'
import { boxCharsFor, boxInnerWidth, type BoxCharSet } from '../box-chars.js'
import { useAsciiBorders } from '../term-caps.js'
import type { RivetTheme } from '../theme.js'

/** ambiguous 恒按 2 列的上界口径（用于「绝不超宽」的兜底判断）。 */
const WIDE = { ambiguousAsWide: true }

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281). Shown in compact mode. */
  numericId?: number
  /** 折叠为单行极简版（用于非首次启动/恢复会话）。 */
  compact?: boolean
  /** 终端可视高度（行）。极矮终端降级为 compact 单行。 */
  rows?: number
  /** Tianshu Code 版本号（来自安装根 package.json），无则不显示。 */
  version?: string | null
  /** 当前权限模式（auto-safe / manual / dangerously-skip-permissions …）。 */
  approvalMode?: string
  /** 当前推理 effort 档位（low / medium / high / max）。 */
  reasoningEffort?: string
  /** 星域线框风格（thin / thick / dots / kimi），与输入框同源；缺省 thin。 */
  separator?: string
}

/** 星阁框 + 首尾呼吸空行 2 行 + 输入框 3 行 + 底部状态栏余量。
 *  框体行数动态：北斗 3 行（含空行）+ 配置/位置 2 行 + 引导 1 行 + handoff 提示 1 行 = 7 内容行 + 顶底框 2 = 9 框体行。 */
const BANNER_ROWS = 11
const RESERVED_ROWS = 5

/** 窄于此列数时星阁不成立（正文挤不下），退 compact 单行。 */
const MIN_BOX_COLS = 48

/** 刊头线右侧留白，chrome 后退，不让线铺满整框。 */
const TAIL_GAP = 6

// ── 北斗七星 ──────────────────────────────────────────────────────────
// 星等取真实视星等（Dubhe 1.79 / Merak 2.37 / Phecda 2.44 / Megrez 3.31 /
// Alioth 1.77 / Mizar 2.23 / Alkaid 1.86）。列距是真实天区的水平投影配比：
// 斗身窄，斗柄按 5:4:6 依次舒展（实际角距 6.1° / 4.7° / 6.6°）。
/** 顶行：斗身上边 + 斗柄。gap = 该星之后的连线列数。 */
const DIPPER_TOP = [
  { name: '天枢', mag: 1.79, gap: 8 },   // Dubhe   斗身左上
  { name: '天权', mag: 3.31, gap: 5 },   // Megrez  斗身右上，斗柄起点
  { name: '玉衡', mag: 1.77, gap: 4 },   // Alioth
  { name: '开阳', mag: 2.23, gap: 6 },   // Mizar
  { name: '瑶光', mag: 1.86, gap: 0 },   // Alkaid
] as const
/** 次行：斗身下边。at = 在「天枢→天权」跨距上的相对位置。 */
const DIPPER_BOWL = [
  { name: '天璇', mag: 2.37, at: 0.22 }, // Merak   斗身左下
  { name: '天玑', mag: 2.44, at: 0.78 }, // Phecda  斗身右下
] as const

/** 首屏引导：按框宽贪心装填，装不下的整条不显示。 */
const TIPS = [
  { cmd: '/init', desc: '生成项目说明' },
  { cmd: '/domain', desc: '切换星域' },
  { cmd: '/help', desc: '全部命令' },
  { cmd: 'ctrl+p', desc: '命令面板' },
] as const

function truncateToWidth(text: string, maxWidth: number): string {
  const ellW = displayWidth('…', WIDE)
  return displayWidth(text, WIDE) > maxWidth
    ? `${truncateToDisplayWidth(text, Math.max(0, maxWidth - ellW), WIDE)}…`
    : text
}

/** cwd 的 `~` 缩写（Claude Code 同款展示口径）。 */
function tildify(cwd: string): string {
  const home = homedir()
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

/**
 * 星阁渲染器 —— 把框几何、字形档位与主题色绑定成一组闭包。
 * 拆出来是因为北斗两行要跨行对齐列位，必须共用同一把宽度尺。
 */
function starLoft(
  theme: RivetTheme,
  chars: BoxCharSet,
  ascii: boolean,
  cal: { ambiguousAsWide?: boolean },
  frame: string,
  frameOpts: { bold: true },
) {
  /** 框线档：色 = theme.muted（提亮一档带色相偏移，避免纯中性灰的"表格感"），
   *  视觉权重 = bold（让框线在暗底上有"压"住的份量，避免纯色色块感）。
   *  与 app.ts 输入框静息档形成可读层次：输入框 = dim（更退），欢迎框 = muted + bold（更精致）。
   *  pulseQuiet 在深底上近乎隐形（实测回归），不能用作 chrome。 */
  /** 连线：按显示列数产出，字符宽 >1 时用空格补足余数，保证列位精确。 */
  const rule = (cols: number): string => {
    if (cols <= 0) return ''
    const hw = displayWidth(chars.h, cal) || 1
    const n = Math.floor(cols / hw)
    return chars.h.repeat(n) + ' '.repeat(cols - n * hw)
  }
  const glyph = (mag: number): string =>
    mag < 1.8 ? (ascii ? '*' : '✦')
    : mag < 3.0 ? (ascii ? '+' : '✧')
    : (ascii ? '.' : '∙')
  const tone = (mag: number): string =>
    mag < 1.8 ? theme.brandColor : mag < 3.0 ? theme.muted : theme.dim

  /** 顶行。返回天权的显示起列，供次行收口对齐。 */
  const top = (width: number): { text: string; bowlRight: number; natural: number } => {
    let text = ''
    let col = 0
    let bowlRight = 0
    DIPPER_TOP.forEach((star, i) => {
      if (star.name === '天权') bowlRight = col
      const g = glyph(star.mag)
      text += color(g, tone(star.mag), i === 0 ? { bold: true } : undefined)
      col += displayWidth(g, cal)
      if (star.gap > 0) {
        text += color(rule(star.gap), frame, frameOpts)
        col += star.gap
      }
    })
    const natural = col
    if (width > col) text += color(rule(width - col), frame, frameOpts)
    return { text, bowlRight, natural }
  }

  /** 次行：`╰─✧────✧─╯`，右角落在天权正下方。 */
  const bowl = (bowlRight: number): string => {
    const [bl, br] = ascii ? ['\\', '/'] : [chars.bl, chars.br]
    let text = color(bl, frame, frameOpts)
    let col = displayWidth(bl, cal)
    for (const star of DIPPER_BOWL) {
      const target = Math.round(bowlRight * star.at)
      if (target > col) {
        text += color(rule(target - col), frame, frameOpts)
        col = target
      }
      const g = glyph(star.mag)
      text += color(g, tone(star.mag))
      col += displayWidth(g, cal)
    }
    if (bowlRight > col) {
      text += color(rule(bowlRight - col), frame, frameOpts)
      col = bowlRight
    }
    return text + color(br, frame, frameOpts)
  }

  return { rule, top, bowl }
}

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80

  const dir = input.cwd.replace(/^.*\//, '')
  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)

  const effortColor = input.reasoningEffort === 'max' || input.reasoningEffort === 'auto' ? theme.secondary
    : input.reasoningEffort === 'high' ? theme.primary
    : input.reasoningEffort === 'off' ? theme.dim
    : theme.muted
  const effortShort = input.reasoningEffort === 'medium' ? 'med' : input.reasoningEffort
  const effortBadge = input.reasoningEffort ? color(`◎${effortShort}`, effortColor) : ''
  const effortLabel = effortBadge ? ` ${color('·', theme.dim)} ${effortBadge}` : ''

  const compactLine = (): string => {
    const numeric = input.numericId ? ` · #${input.numericId}` : ''
    const line = `${color('✦', theme.brandColor, { bold: true })} ${color('天枢', theme.brandColor, { bold: true })}${numeric}  ${color('·', theme.dim)}  ${color(input.modelName, theme.secondary)}${effortLabel}  ${color('·', theme.dim)}  ${color(dir + '/', theme.muted)}  ${color('·', theme.dim)}  ${color(session, theme.muted)}  ${color('·', theme.dim)}  ${color('/help', theme.secondary)}`
    return truncateToWidth(line, cols)
  }

  // 折叠模式：单行极简提示，适合恢复会话或非首次启动
  if (input.compact) return [compactLine()]

  // 高度自适应：极矮终端（放不下星阁 + 输入框）退单行。
  const rows = input.rows && input.rows > 0 ? input.rows : Number.POSITIVE_INFINITY
  if (rows < BANNER_ROWS + RESERVED_ROWS) return [compactLine()]

  // 宽度自适应：框内挤不下正文时，星阁不如单行诚实。
  if (cols < MIN_BOX_COLS) return [compactLine()]

  // ── 星阁 ──────────────────────────────────────────────────────────
  const ascii = useAsciiBorders()
  const chars = boxCharsFor(input.separator ?? 'thin')
  const inner = boxInnerWidth(cols)
  const outer = inner + 4
  // 度量口径取探测档（同 input-line.ts / live-tail-cap.ts）：这是静态 scrollback
  // 块，不参与 LiveEngine 回顶计算，按终端实际渲染宽度对齐右边线即可，
  // 不必像 live region 那样一律取 wide 上界（那会让右边线在多数终端内缩数列）。
  const cal = { ambiguousAsWide: ambiguousWideEnabled() }
  // 框线档提到外层——vBar、顶底框、starLoft 内的框线衍生（斗身边线、尾随续线）
  // 全部走同一种色 + 视觉权重（muted + bold），确保"框"作为一个整体立得住。
  const frameOpts = { bold: true } as const
  const frame = theme.muted
  const loft = starLoft(theme, chars, ascii, cal, frame, frameOpts)
  const vBar = color(chars.v, frame, frameOpts)

  /** 框内一行：内容截断/补齐到 inner，两侧竖边线。 */
  const row = (content: string): string => {
    const clipped = displayWidth(content, cal) > inner
      ? truncateToDisplayWidth(content, inner, cal)
      : content
    // 补齐量同时受 wide 上界约束：万一探测失准（CJK 终端开了 ambiguous
    // double-width 却没设 RIVET_AMBIGUOUS_WIDTH），宁可右边线内缩一两列，
    // 也不能整行超出 cols 折行。框外宽 = cols-2，正好留 2 列冗余。
    const gap = Math.min(
      inner - displayWidth(clipped, cal),
      cols - 4 - displayWidth(clipped, WIDE),
    )
    return `${vBar} ${clipped}${' '.repeat(Math.max(0, gap))} ${vBar}`
  }

  // 顶框：`╭─ 天枢 T I Ā N S H Ū Code ──…── v2.23.0 ─╮`
  // wordmark 三档降级——宽字距拼音是最完整形态，窄了退回英文品牌名，再窄只留中文。
  const wordmarkFor = (plain: string): string => {
    if (plain === '天枢') return color('天枢', theme.brandColor, { bold: true })
    if (plain === '天枢 Tianshu Code') {
      return `${color('天枢', theme.brandColor, { bold: true })} ${color('Tianshu Code', theme.muted)}`
    }
    return `${color('天枢', theme.brandColor, { bold: true })}  ${color('T I Ā N S H Ū', theme.secondary)}  ${color('Code', theme.muted)}`
  }
  const versionText = input.version ? `v${input.version}` : ''
  const wordmarkPlain = ['天枢  T I Ā N S H Ū  Code', '天枢 Tianshu Code', '天枢'].find(
    plain => outer - 8 - displayWidth(plain, cal) - displayWidth(versionText, cal) >= 2,
  ) ?? '天枢'
  const wordmarkW = displayWidth(wordmarkPlain, cal)
  const fill = outer - 8 - wordmarkW - displayWidth(versionText, cal)
  const topBorder = versionText && fill >= 2
    ? color(`${chars.tl}${chars.h} `, frame, frameOpts) + wordmarkFor(wordmarkPlain)
      + ` ${color(loft.rule(fill), frame, frameOpts)} ${color(versionText, theme.dim)}`
      + color(` ${chars.h}${chars.tr}`, frame, frameOpts)
    : color(`${chars.tl}${chars.h} `, frame, frameOpts) + wordmarkFor(wordmarkPlain)
      + color(` ${loft.rule(Math.max(0, outer - 5 - wordmarkW))}${chars.tr}`, frame, frameOpts)

  const bottomBorder = color(`${chars.bl}${chars.h.repeat(inner + 2)}${chars.br}`, frame, frameOpts)

  // 北斗两行：装不下整幅就整块省掉，不画半只勺子。
  const probe = loft.top(0)
  const body: string[] = []
  if (inner >= probe.natural + TAIL_GAP) {
    const top = loft.top(inner - TAIL_GAP)
    body.push(top.text, loft.bowl(top.bowlRight), '')
  }

  // 配置行 + 位置行（沿用概念 A 的信息设计）。
  const modeLabel = input.approvalMode === 'dangerously-skip-permissions' ? 'yolo' : input.approvalMode
  const modeSuffix = modeLabel ? ` ${color('·', theme.dim)} ${color(modeLabel, theme.muted)}` : ''
  const idLabel = input.numericId ? `#${input.numericId}` : session
  // 框内不用 `·` 隔开 model 与 effort（effort 本就是模型属性）：`·` 与 `◎` 都是
  // East-Asian Ambiguous，一行超过 2 个就吃光框的冗余、逼右边线内缩一列。
  body.push(`${color(input.modelName, theme.muted)}${effortBadge ? ` ${effortBadge}` : ''}${modeSuffix}`)
  body.push(`${color(tildify(input.cwd), theme.muted)} ${color('·', theme.dim)} ${color(idLabel, theme.dim)}`)

  // 引导行：贪心装填，一条都装不下就不占行。
  let tipsPlain = ''
  let tipsText = ''
  for (const tip of TIPS) {
    const piece = `${tip.cmd} ${tip.desc}`
    const next = tipsPlain ? `${tipsPlain}   ${piece}` : piece
    if (displayWidth(next, cal) > inner) break
    tipsText += (tipsPlain ? '   ' : '') + `${color(tip.cmd, theme.brandColor)} ${color(tip.desc, theme.muted)}`
    tipsPlain = next
  }
  if (tipsText) body.push('', tipsText)

  // handoff 提示行：使用中提醒（非启动引导），独立成行避免贪心装填挤压。
  // 与会话中 formatHandoffNudge 同口径——首屏先埋一次认知，≥70% 时再提醒。
  // 内容不带边线（row() 统一加），超宽时 truncateToDisplayWidth 安全截断带色串。
  const handoffFull = `${color('⏜', theme.secondary)} ${color('/handoff', theme.brandColor)} ${color('上下文 70% 后交接给新会话（文档自动注入，比续跑省前缀重建）', theme.muted)}`
  const handoffShort = `${color('⏜', theme.secondary)} ${color('/handoff', theme.brandColor)} ${color('上下文 70% 后交接给新会话', theme.muted)}`
  body.push(displayWidth(handoffFull, cal) > inner ? handoffShort : handoffFull)

  // 首尾空行是呼吸位：清屏后不贴顶边，底框也不与输入框顶框直接粘连
  // （main.ts 把输入框 append 在欢迎页正下方）。
  return ['', topBorder, ...body.map(row), bottomBorder, '']
}
