import type { StarPhase } from '../../agent/star-event.js'
import type { AvatarMode, AvatarFrame, FaceExpression, DomainId, SealCrown } from './types.js'

/**
 * 星君帧模板
 *
 * 国风设计：印章冠 + kaomoji 面 + 中国礼仪手势
 * 印章是中国最小的完整信息单元 — 方寸之间，气象万千。
 */

// ─── 印章冠定义 ─────────────────────────────────────────────────────

/** 天玑星君（文星）印章冠 */
export const WENXING_SEAL: SealCrown = {
  top: '╭文╮',
  middle: '│星│',
  bottom: '╰┬╯',
}

/** 玉衡星君（武曲）印章冠 */
export const WUXING_SEAL: SealCrown = {
  top: '╭武╮',
  middle: '│曲│',
  bottom: '╰┬╯',
}

/** 天枢再临印章冠 */
export const TIANXU_SEAL: SealCrown = {
  top: '╭天╮',
  middle: '│枢│',
  bottom: '╰┬╯',
}

/** 归航星芒印章冠 */
export const STAR_SEAL: SealCrown = {
  top: '╭✦╮',
  middle: '│星│',
  bottom: '╰┬╯',
}

// ─── 中国礼仪手势 ───────────────────────────────────────────────────

/**
 * 文武模式对应的手势
 *
 * 拱手礼：文官最高礼节 — 双手合抱于胸前
 * 抱拳礼：武官最高礼节 — 左掌右拳合抱
 */
export const GESTURES: Record<AvatarMode, string> = {
  wenxing: '拱手',
  wuxing: '抱拳',
}

// ─── 星域配饰 ───────────────────────────────────────────────────────

/**
 * 星域配饰符号
 *
 * 叠加在印章冠右侧，不改变文/武模式。
 */
const DOMAIN_BADGE: Record<string, string> = {
  pojun: '⚔',
  tianfu: '🛡',
  tianliang: '📏',
}

// ─── 状态标签 ───────────────────────────────────────────────────────

/**
 * 每个星相位的状态文字
 *
 * 文化设计：
 * - 文星模式用省略号「…」表示沉思
 * - 武曲模式用感叹号「!」表示行动
 * - 试锋用波浪号「~」表示不确定性
 */
export const STATUS_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '思考中…',
  'tianxuan-locating': '搜索中…',
  'tianji-decomposing': '拆解中…',
  'tianquan-contracting': '签约中…',
  'yuheng-implementing': '编码中!',
  'kaiyang-testing': '验证中~',
  'yaoguang-delivering': '归航!',
  'tianshu-encore': '重新审视',
}

// ─── 印章冠选择 ─────────────────────────────────────────────────────

/**
 * 根据模式和相位选择印章冠
 *
 * @param mode 文/武模式
 * @param phase 星相位
 * @returns 印章冠
 */
function selectSeal(mode: AvatarMode, phase: StarPhase): SealCrown {
  // 再临用天枢印章
  if (phase === 'tianshu-encore') return TIANXU_SEAL
  // 归航用星芒印章
  if (phase === 'yaoguang-delivering') return STAR_SEAL
  // 武曲模式用武曲印章
  if (mode === 'wuxing') return WUXING_SEAL
  // 默认文星印章
  return WENXING_SEAL
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * 构建完整的星君帧
 *
 * 组合印章冠 + kaomoji 面部 + 中国礼仪手势 + 状态文字
 *
 * @param mode 文/武模式
 * @param face kaomoji 面部表达
 * @param phase 星相位
 * @param domain 星域（破军/天府/天梁）
 * @returns 完整的 AvatarFrame
 */
export function buildFrame(
  mode: AvatarMode,
  face: FaceExpression,
  phase: StarPhase,
  domain: DomainId,
): AvatarFrame {
  const seal = selectSeal(mode, phase)
  const gesture = GESTURES[mode]
  const status = STATUS_LABELS[phase]

  // 面部字符串
  const faceStr = `${face.leftEye}${face.mouth}${face.rightEye}`

  // 星域配饰
  const badge = domain ? DOMAIN_BADGE[domain] ?? '' : ''

  // 构建帧行
  const rawLines = [
    seal.top + badge,           // 印章冠上框 + 配饰
    seal.middle,                // 印章冠中框（名号）
    seal.bottom,                // 印章冠下框（连接线）
    faceStr,                    // kaomoji 面部
    `╱${gesture.charAt(0)}╲`,  // 手势上半
    `╲${gesture.charAt(1)}╱`,  // 手势下半
    status,                     // 状态文字
  ]

  // 计算最大宽度并填充
  const maxWidth = Math.max(...rawLines.map(l => [...l].length))
  const lines = rawLines.map(l => l.padEnd(maxWidth - [...l].length + l.length))

  return {
    crown: seal,
    face,
    gesture,
    status,
    lines,
    width: maxWidth,
    height: lines.length,
  }
}
