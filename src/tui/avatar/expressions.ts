import type { StarPhase } from '../../agent/star-event.js'
import type { AvatarMode, AvatarMood, FaceExpression } from './types.js'

/**
 * 星君表情系统
 *
 * 核心设计原则：
 * 1. 萌三角：眼+嘴构成倒三角，3 个字符传达情绪（来自 Chibi 设计研究）
 * 2. 模式优先：文/武切换比微表情变化显眼 100 倍（来自布袋戏洞察）
 * 3. 永不静止：呼吸节奏 + 眨眼循环 = 灵魂底线（来自木偶戏共识）
 */

// ─── 表情映射表 ─────────────────────────────────────────────────────

/**
 * 10 种情绪的 kaomoji 面部表达
 *
 * 全球通用：kaomoji 是终端原生语言，零学习成本。
 * 不触发恐怖谷效应。
 */
const EXPRESSIONS: Record<AvatarMood, FaceExpression> = {
  // 天玑星君（文星）情绪
  calm:      { leftEye: '◠', mouth: '‿', rightEye: '◠' },   // 平静：静如处子
  searching: { leftEye: '◉', mouth: '_', rightEye: '◉' },   // 搜索：眼观六路
  satisfied: { leftEye: '◡', mouth: '▽', rightEye: '◡' },   // 满意：运筹帷幄
  content:   { leftEye: '◡', mouth: '▿', rightEye: '◡' },   // 欣慰：功成身退

  // 玉衡星君（武曲）情绪
  focused:   { leftEye: '●', mouth: '△', rightEye: '●' },   // 专注：横刀立马
  tense:     { leftEye: '◎', mouth: '─', rightEye: '◎' },   // 紧张：目不转睛

  // 特殊状态情绪
  serious:   { leftEye: '●', mouth: '─', rightEye: '●' },   // 严肃：故人重逢
  confused:  { leftEye: '×', mouth: '~', rightEye: '×' },   // 困惑：百思不解
  surprised: { leftEye: '○', mouth: '△', rightEye: '○' },   // 惊讶：大惊失色
  greeting:  { leftEye: '◠', mouth: '▽', rightEye: '◠' },   // 致意：初出茅庐
}

// ─── 眨眼映射 ───────────────────────────────────────────────────────

/**
 * 眨眼时的字符替换
 *
 * 来自木偶戏共识："死掉的木偶就是静止的木偶"。
 * 微小眨眼是灵魂底线。
 */
const BLINK: Record<string, string> = {
  '◠': '─',
  '◉': '─',
  '●': '─',
  '◡': '─',
  '◎': '─',
  '×': '─',
  '○': '─',
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * 获取 kaomoji 面部表达
 *
 * @param mood 当前情绪
 * @param tick 动画 tick 计数
 * @returns 面部表达（左眼 + 嘴 + 右眼）
 *
 * 眨眼规则：tick 能被 20 整除且不为 0 时眨眼。
 */
export function getFace(mood: AvatarMood, tick: number): FaceExpression {
  const base = EXPRESSIONS[mood]
  if (tick === 0 || tick % 20 !== 0) return base
  return {
    leftEye: BLINK[base.leftEye] ?? base.leftEye,
    mouth: base.mouth,
    rightEye: BLINK[base.rightEye] ?? base.rightEye,
  }
}

/**
 * 星相位 → 文/武模式映射
 *
 * 设计原则：执行阶段（铸形/试锋）为武曲，其余为文星。
 * 来自布袋戏文生/武生双模美学。
 *
 * @param phase 当前星相位
 * @returns 'wenxing' 或 'wuxing'
 */
export function phaseToMode(phase: StarPhase): AvatarMode {
  if (phase === 'yuheng-implementing' || phase === 'kaiyang-testing') return 'wuxing'
  return 'wenxing'
}

/**
 * 星相位 + 状态 → 情绪映射
 *
 * 优先级：
 * 1. isStuck → confused（困惑优先级最高）
 * 2. isTestFailing → surprised（测试失败次之）
 * 3. 根据 phase 映射到对应情绪
 *
 * @param phase 当前星相位
 * @param isStuck 是否卡住
 * @param isTestFailing 是否测试失败
 * @returns 情绪状态
 */
export function phaseToMood(phase: StarPhase, isStuck: boolean, isTestFailing: boolean): AvatarMood {
  // 卡住优先级最高
  if (isStuck) return 'confused'
  // 测试失败次之
  if (isTestFailing) return 'surprised'
  // 根据 phase 映射
  switch (phase) {
    case 'tianshu-planning': return 'calm'
    case 'tianxuan-locating': return 'searching'
    case 'tianji-decomposing': return 'focused'
    case 'tianquan-contracting': return 'satisfied'
    case 'yuheng-implementing': return 'focused'
    case 'kaiyang-testing': return 'tense'
    case 'yaoguang-delivering': return 'content'
    case 'tianshu-encore': return 'serious'
    default: {
      // Exhaustive check — TypeScript will error if a new StarPhase is added
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}
