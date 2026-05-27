import type { StarPhase } from '../../agent/star-event.js'
import type { AlchemyStage } from '../alchemy-bar.js'

/**
 * Star Domain IDs — from domain-voice.ts
 * Kept as independent type to avoid cross-module coupling.
 */
export type DomainId = 'tianshu' | 'pojun' | 'tianfu' | 'tianliang' | null

/**
 * 三国英雄 ID — 工程预留
 *
 * 用于标识当前激活的英雄伴侣。
 * null = 使用默认星君（文/武双身模式）
 *
 * 设计文档：docs/superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md
 *
 * 注：当前阶段仅预留类型，实际英雄帧模板待美工设计完成后填入。
 */
export type HeroId =
  | 'liubei'    // 刘备 — 天枢，仁德之主
  | 'zhuge'     // 诸葛亮 — 天璇，智慧化身
  | 'pangtong'  // 庞统 — 天玑，凤雏之智
  | 'guanyu'    // 关羽 — 天权，义薄云天
  | 'zhangfei'  // 张飞 — 玉衡，万夫莫敌
  | 'zhaoyun'   // 赵云 — 开阳，浑身是胆
  | 'huangzhong' // 黄忠 — 摇光，老当益壮
  | null        // 默认星君模式

/**
 * 文星模式：天玑星君（文星）或玉衡星君（武曲）
 *
 * - wenxing (文星): 观局、寻迹、拆解、定标、归航 — 缓慢、儒雅、拱手礼
 * - wuxing (武曲): 铸形、试锋 — 快速、刚猛、抱拳礼
 */
export type AvatarMode = 'wenxing' | 'wuxing'

/**
 * 星君情绪状态
 *
 * 10 种离散情绪，通过 kaomoji 面部表达。
 * 设计原则：模式切换 > 微表情变化（来自布袋戏洞察）
 */
export type AvatarMood =
  | 'calm'       // 平静 — 天玑星君观局 (◠‿◠)
  | 'searching'  // 搜索 — 天玑星君寻迹 (◉_◉)
  | 'focused'    // 专注 — 玉衡星君铸形 (●△●)
  | 'satisfied'  // 满意 — 天玑星君定标 (◡▽◡)
  | 'content'    // 欣慰 — 天玑星君归航 (◡▿◡)
  | 'tense'      // 紧张 — 玉衡星君试锋 (◎─◎)
  | 'serious'    // 严肃 — 天枢再临 (●─●)
  | 'confused'   // 困惑 — 卡住 (×~×)
  | 'surprised'  // 惊讶 — 测试失败 (○△○)
  | 'greeting'   // 致意 — 开场 (◠▽◠)

/**
 * 印章冠：CJK 字符 + 边框
 *
 * 中国最小的完整信息单元 — 方寸之间，气象万千。
 * CJK 字符在等宽字体中天然等宽，终端渲染零兼容问题。
 */
export interface SealCrown {
  /** 上框：'╭文╮' / '╭武╮' / '╭天╮' / '╭✦╮' */
  top: string
  /** 中框：'│星│' / '│曲│' / '│枢│' / '│星│' */
  middle: string
  /** 下框：'╰┬╯'（连接线通向面部） */
  bottom: string
}

/**
 * kaomoji 面部表达（全球通用）
 *
 * 3 字符面部 = 萌三角：左眼 + 嘴 + 右眼
 * 来自 Chibi 设计研究：最低 3 个字符就能表达面部。
 */
export interface FaceExpression {
  leftEye: string
  mouth: string
  rightEye: string
}

/**
 * 完整星君帧
 *
 * 组合印章冠 + kaomoji 面部 + 中国礼仪手势 + 状态文字
 */
export interface AvatarFrame {
  /** 印章冠：CJK 字符 + 边框 */
  crown: SealCrown
  /** kaomoji 面部表达 */
  face: FaceExpression
  /** 中国礼仪手势（拱手/抱拳） */
  gesture: string
  /** 状态文字 */
  status: string
  /** 渲染后的完整帧（每行一个字符串） */
  lines: string[]
  /** 最大行宽度 */
  width: number
  /** 帧高度（行数） */
  height: number
}

/**
 * 星君渲染上下文
 *
 * 包含渲染星君帧所需的全部运行时状态。
 */
export interface AvatarContext {
  /** 当前星相位 */
  phase: StarPhase
  /** 炼金阶段 */
  alchemy: AlchemyStage
  /** 星域（破军/天府/天梁） */
  domain: DomainId
  /** 当前情绪 */
  mood: AvatarMood
  /** 文/武模式 */
  mode: AvatarMode
  /** 动画 tick 计数 */
  tick: number
  /** 是否卡住 */
  isStuck: boolean
  /** 是否测试失败 */
  isTestFailing: number
  /** 空闲秒数 */
  idleSeconds: number
  /**
   * 当前激活的英雄（工程预留）
   *
   * null = 默认星君模式（文/武双身）
   * 具体英雄 ID = 英雄伴侣模式（待美工设计后实现）
   *
   * 设计文档：docs/superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md
   */
  hero?: HeroId
}
