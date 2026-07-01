import chalk from 'chalk'

export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  muted: string
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
  userColor: string
  assistantColor: string
  systemColor: string
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}

export const THEME_NAMES = [
  'pastel', 'cyberpunk', 'observatory', 'midnight', 'starfield', 'tianshu',
  'claude', 'ziwei', 'slate', 'antigravity', 'cobalt', 'gemini',
] as const

export type ThemeName = typeof THEME_NAMES[number]

interface ColorSet {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
  /** bash/grep/glob 工具色，默认回退到 primary */
  toolShell?: string
  /** edit_file/write_file 工具色，默认回退到 secondary */
  toolEdit?: string
  /** run_tests 工具色，默认回退到 success */
  toolTest?: string
  /** delegate_task/delegate_batch 工具色，默认回退到 warning */
  toolDelegate?: string
}

// Pastel theme — soft, pleasant, 二次元-inspired (default)
// Based on Soft UI Evolution: improved contrast pastels on dark terminal background
const PASTEL_TRUECOLOR: ColorSet = {
  primary: '#a8e6cf',   // mint green — search/grep/glob
  secondary: '#d4a5f5', // lavender — edit/write
  success: '#b5ead7',   // soft green — tests pass
  warning: '#ffdac1',   // warm peach — delegation/warnings
  error: '#ff9aa2',     // coral pink — errors
  dim: '#8585a0',       // soft gray — secondary info
  pulseQuiet: '#4a4a5a', // dim violet gray — dark cockpit quiet
  pulseActive: '#a8e6cf', // mint green — active pulse
  pulseAlert: '#ff9aa2',  // coral pink — alert pulse
}

const PASTEL_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Cyberpunk theme — neon tech-noir, tuned for legibility on near-black bg.
// Original maxed-out neons (#00ffcc/#7b2fff/#00ff88/#ff3333) had two defects on
// dark terminals: (1) the electric purple secondary failed WCAG AA (3.3:1) and
// vibrated against black; (2) primary cyan-green and success green were nearly
// the same hue, so they read as one color. Fix per dark-mode color rules: raise
// lightness + ease saturation, split the greens (cyan primary vs green success),
// lift the purple to a readable lavender, swap pure-red for rose to kill halation.
const CYBERPUNK_TRUECOLOR: ColorSet = {
  primary: '#22d3ee',   // cyan-400 — distinct cyan (was #00ffcc, collided w/ success)
  secondary: '#c4a3ff', // lavender — readable violet, 9:1 (was #7b2fff, failed AA 3.3:1)
  success: '#4ade80',   // green-400 — clearly green, separated from primary cyan
  warning: '#fbbf24',   // amber-400 — softer than raw orange, still neon-warm
  error: '#fb7185',     // rose-400 — alarming without pure-red halation on black
  dim: '#6b6b8f',       // raised violet-gray so dividers are actually visible (was 2.5:1)
  pulseQuiet: '#2f3048',
  pulseActive: '#22d3ee',
  pulseAlert: '#fb7185',
}

const CYBERPUNK_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Observatory theme — 五色星辰 (Five-Color Star Palette)
// 基于中国传统五色体系，北斗七星在北方 → 水 → 玄色
const OBSERVATORY_TRUECOLOR: ColorSet = {
  primary: '#4f46e5',   // 靛蓝 (indigo) — 天玑星君主色，青出于蓝
  secondary: '#a78bfa', // 星云紫 — 星云/辅助色
  success: '#34d399',   // 验证翠 — 测试通过/归航
  warning: '#f59e0b',   // 星金黄 — 活跃星/炼金高阶
  error: '#f87171',     // 警报珊 — 错误/高风险
  dim: '#64748b',       // 远星灰 — 非活跃/次要信息
  pulseQuiet: '#334155', // 玄灰 — quiet pulse
  pulseActive: '#38bdf8', // 天青 — active pulse
  pulseAlert: '#f87171',  // 警报珊 — alert pulse
}

const OBSERVATORY_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Midnight theme — GitHub Dark inspired, clear hierarchy, functional color
// Three-layer gray (fg / muted / subtle) + single accent blue + semantic colors
const MIDNIGHT_TRUECOLOR: ColorSet = {
  primary: '#58a6ff',   // accent blue — links, selection, active
  secondary: '#b0b8c4', // medium gray — labels, data values (bumped from #8b949e)
  success: '#3fb950',   // green — pass, active pulse
  warning: '#d29922',   // gold — attention, delegation
  error: '#f85149',     // red — errors, alerts
  dim: '#6e7681',       // subtle gray — separators, decoration only
  pulseQuiet: '#3d4450', // dark border gray — quiet pulse
  pulseActive: '#58a6ff', // accent blue — active pulse
  pulseAlert: '#f85149',  // red — alert pulse
}

const MIDNIGHT_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'white',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blue',
  pulseAlert: 'red',
}

// Starfield theme — 星空/星座. Rivet's home aesthetic (the Big Dipper star-map).
// Astronomy-semantic palette: every accent is a kind of star/sky phenomenon, all
// tuned bright + slightly desaturated so they glow on deep-space black without the
// vibration of pure neon. All text colors clear WCAG AA (8:1+) on near-black.
const STARFIELD_TRUECOLOR: ColorSet = {
  primary: '#8ab4ff',   // hot blue-white star (Vega/Rigel) — links, search/bash
  secondary: '#c9a9ff', // nebula violet — edit/write, headers
  success: '#7ee7c7',   // aurora teal-green — tests pass, return-home
  warning: '#ffd479',   // stellar gold (Sol/Arcturus) — delegation/attention
  error: '#ff8a9b',     // nova / red-giant flare — errors
  dim: '#6b7394',       // cosmic dust lane — separators, decoration (4:1, visible)
  pulseQuiet: '#2b3052', // deep space blue-gray — quiet pulse
  pulseActive: '#8ab4ff', // star blue — active pulse
  pulseAlert: '#ff8a9b',  // nova red — alert pulse
}

const STARFIELD_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'magenta',
  success: 'cyan',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blue',
  pulseAlert: 'red',
}

// Tianshu theme — 玄夜墨色 (Ink-Night). Design: 95% 墨灰 + 紫微紫 accent + 朱砂用户标记.
// 功能态全部降饱和：归航青/星金/朱砂赤。工具按类别弱分色。
const TIANSHU_TRUECOLOR: ColorSet = {
  primary: '#dfb282',   // 星金 accent — 提亮优化，更有光泽
  secondary: '#a49ac7', // 墨紫灰 — 柔和星云紫 (soft violet)
  success: '#75a399',   // 归航青 — tests/done松石绿
  warning: '#b09155',   // 星金 — delegation/attention
  error: '#c1655c',     // 朱砂赤 — errors
  dim: '#666a78',       // 暗墨 — separators/shortcuts
  pulseQuiet: '#3a3d4a', // 墨线 — quiet pulse
  pulseActive: '#dfb282', // 星金 — active pulse (matches primary)
  pulseAlert: '#d4453a',  // 朱砂印 — alert pulse
  toolShell: '#a0a3b0',   // shell grey — bash/grep/glob
  toolEdit: '#a49ac7',    // 墨紫灰 — edit_file/write_file (matches secondary)
  toolTest: '#9c8a63',    // 金褐 — run_tests
  toolDelegate: '#b09155', // 星金 — delegate
}

const TIANSHU_FALLBACK: ColorSet = {
  primary: 'yellow',    // closest named color for warm gold
  secondary: 'magenta',
  success: 'cyan',
  warning: 'yellow',
  error: 'red',
  dim: 'white',         // brightened for readability
  pulseQuiet: 'gray',
  pulseActive: 'yellow',
  pulseAlert: 'red',
}

// Ziwei theme — 紫微北斗·墨夜 (Ink-Night Purple Accent)
// Design: 95% 墨灰 + 紫微紫 primary + 朱砂红 userColor.
const ZIWEI_TRUECOLOR: ColorSet = {
  primary: '#c9b8ff',     // 紫微 — 帝星紫，身份/链接/选中
  secondary: '#8ab4ff',   // 天枢蓝白 — 北斗主序星色，正文强调
  success: '#7ee7c7',     // 归航青 — 测试通过/完成 (木/林)
  warning: '#ffd479',     // 星金 — 注意/委派 (土/山)
  error: '#ff8a9b',       // 荧惑赤 — 错误/高风险 (火)
  dim: '#5a5f7a',         // 星尘灰 — 分隔/次要
  pulseQuiet: '#3a3d4a',  // 墨线 — quiet pulse
  pulseActive: '#c9b8ff', // 紫微 — active pulse
  pulseAlert: '#d4453a',  // 朱砂印 — alert pulse (user indicator color)
  toolShell: '#8ab4ff',   // 天枢蓝白 — bash/grep/glob
  toolEdit: '#c9b8ff',    // 紫微紫 — edit_file/write_file
  toolTest: '#7ee7c7',    // 归航青 — run_tests
  toolDelegate: '#ffd479' // 星金 — delegate
}

const ZIWEI_FALLBACK: ColorSet = {
  primary: 'magenta',
  secondary: 'blue',
  success: 'cyan',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'magenta',
  pulseAlert: 'red',
}

// Claude theme — Claude Code TUI palette port. Mirrors the RGB values from
// claude-code-haha/src/utils/theme.ts darkTheme (Claude Code's own ANSI改造 TUI),
// so we can switch between the two terminals without retraining the eye.
// Truecolor RGB values are kept verbatim from upstream; fallback resolves to the
// matching dark-ansi 16-color names so 256-color terminals get the same identity.
const CLAUDE_TRUECOLOR: ColorSet = {
  primary: '#d77757',   // Claude Code `claude` rgb(215,119,87) — brand orange
  secondary: '#af87ff', // `autoAccept` rgb(175,135,255) — electric violet
  success: '#4eba65',   // `success` rgb(78,186,101) — bright green
  warning: '#ffc107',   // `warning` rgb(255,193,7) — bright amber
  error: '#ff6b80',     // `error` rgb(255,107,128) — bright red
  dim: '#505050',       // `subtle` rgb(80,80,80) — dark gray
  pulseQuiet: '#888888',    // `promptBorder` rgb(136,136,136) — medium gray
  pulseActive: '#d77757',   // = primary (Claude brand orange pulse)
  pulseAlert: '#ff6b80',    // = error (alert pulse)
}

const CLAUDE_FALLBACK: ColorSet = {
  primary: 'redBright',     // dark-ansi `claude` = redBright
  secondary: 'magentaBright', // `autoAccept` = magentaBright
  success: 'greenBright',
  warning: 'yellowBright',
  error: 'redBright',
  dim: 'white',            // dark-ansi `subtle` = white
  pulseQuiet: 'white',     // `promptBorder` = white
  pulseActive: 'redBright',
  pulseAlert: 'redBright',
}

// Slate theme — 默认风格 (Professional / Calm). Design brief: 去强调紫，做专业、
// 年轻化、不花哨、视觉不疲劳。手法：单一冷静 teal accent + 钢蓝结构色 + 全部去饱和
// 语义色 + 柔和中性灰白正文（非纯白，降眩光）。暗色终端长时间观看不疲劳。
const SLATE_TRUECOLOR: ColorSet = {
  primary: '#56b6c2',   // 冷静 teal-cyan — 唯一 accent：链接/选中/相位字形/流式指示
  secondary: '#7aa2cf', // 钢蓝 — 正文结构强调 / edit·write 头
  success: '#7fb88a',   // 鼠尾草绿 — 测试通过/完成 (去饱和)
  warning: '#d6a35c',   // 暗琥珀 — 注意/委派
  error: '#e08891',     // 柔玫瑰 — 错误/高风险 (低光晕，非纯红)
  dim: '#5b6270',       // 板岩灰 — 分隔/快捷键 (安静可见)
  pulseQuiet: '#39414f', // 深板岩 — quiet pulse
  pulseActive: '#56b6c2', // teal — active pulse (= primary)
  pulseAlert: '#e08891',  // 柔玫瑰 — alert pulse (= error)
  toolShell: '#7aa2cf',   // 钢蓝 — bash/grep/glob
  toolEdit: '#6fb3ab',    // 雾青 — edit_file/write_file (区别于 shell 蓝与 success 绿)
  toolTest: '#7fb88a',    // 鼠尾草绿 — run_tests
  toolDelegate: '#d6a35c', // 暗琥珀 — delegate
}

const SLATE_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'blue',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Antigravity 2.0 — Codex cool azure, aligned with desktop tokens.css.
// Single restrained accent: #5aa9ff sky-blue. Semantic colors lifted from
// desktop --success / --warning / --error. Zero purple — no ziwei residue.
// Dark-background tuned: chroma up ~8% vs web so truecolor glows on near-black.
const ANTIGRAVITY_TRUECOLOR: ColorSet = {
  primary: '#5aa9ff',   // cool azure — 唯一 accent (desktop --accent)
  secondary: '#8ab4ff', // 浅天青 — 结构强调 / edit·write 头
  success: '#43c463',   // 翠绿 — 测试通过/完成 (desktop --success)
  warning: '#e0a93a',   // 琥珀 — 注意/委派 (desktop --warning)
  error: '#f76b6b',     // 珊瑚红 — 错误 (desktop --error)
  dim: '#6c6e7a',       // 暗灰 — 分隔/快捷键 (desktop --faint)
  pulseQuiet: '#2a2a32', // 边框灰 — quiet pulse (desktop --border)
  pulseActive: '#5aa9ff', // azure — active pulse (= primary)
  pulseAlert: '#f76b6b',  // coral — alert pulse (= error)
  toolShell: '#7aa2cf',   // 钢蓝 — bash/grep/glob
  toolEdit: '#6fb3ab',    // 雾青 — edit_file/write_file (区别于 shell 蓝)
  toolTest: '#43c463',    // 翠绿 — run_tests
  toolDelegate: '#e0a93a', // 琥珀 — delegate
}

const ANTIGRAVITY_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blue',
  pulseAlert: 'red',
}

// Cobalt theme — 钴蓝·冷调中性 (default). 由子代理/team TUI 设计稿提炼，oklch 调和：
// 中性灰阶统一色相 ~250°（微偏蓝冷，不发死灰），状态色全部拽进与 azure 同一和谐色环
// （青绿 ok / 珊瑚 err / 冷琥珀 warn），不刺眼但仍可语义辨识。是 antigravity 的精炼继任者：
// 同源冷 azure，但语义色去糖果化、明度梯度更清晰。可与桌面端 tokens.css 对照移植。
const COBALT_TRUECOLOR: ColorSet = {
  primary: '#6ab8ff',   // 钴蓝 accent — 流式指示/链接 (--tui-accent)
  secondary: '#7dacbf', // 雾青灰 — 结构头/编辑头/非选中项 (偏青灰，拉开与 primary 蓝的层次)
  success: '#58cbb4',   // 青绿 — 测试通过/完成 (--tui-ok, teal-green 偏冷)
  warning: '#d4b44c',   // 琥珀金 — 注意/委派/stall (偏金有光泽感，深色背景不泥)
  error: '#ed7665',     // 珊瑚砖红 — 错误/高风险 (--tui-err, 去糖果感)
  dim: '#8693a0',       // 冷板岩灰 — 分隔/快捷键 (提亮一档，5.8→6.4:1 对比度)
  pulseQuiet: '#30363d', // 冷边框灰 — quiet pulse (--tui-border)
  pulseActive: '#6ab8ff', // 钴蓝 — active pulse (= primary)
  pulseAlert: '#ed7665',  // 珊瑚 — alert pulse (= error)
  toolShell: '#5f97c5',   // 壳蓝 — bash/grep/glob (加深加饱和，与亮钴蓝 primary 形成层次)
  toolEdit: '#65b9ca',    // 冷青 — edit_file/write_file (区别于 shell 蓝与 success 青绿)
  toolTest: '#58cbb4',    // 青绿 — run_tests (= success)
  toolDelegate: '#d4b44c', // 琥珀金 — delegate (= warning)
}

const COBALT_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blue',
  pulseAlert: 'red',
}

// Gemini theme — Indigo, Purple & Mint Teal inspired by Gemini aesthetics
const GEMINI_TRUECOLOR: ColorSet = {
  primary: '#818cf8',      // Gemini Indigo — Cold Indigo Blue accent
  secondary: '#c084fc',    // Nebula Violet — Radiant Violet
  success: '#34d399',      // Aurora Mint — Cold Teal-Green
  warning: '#fbbf24',      // Stellar Amber — Bright Golden Amber
  error: '#f43f5e',        // Cosmic Rose — Vibrant desaturated Rose-Red
  dim: '#5e617d',          // Nebula Gray — Elevated dividers/shortcuts
  pulseQuiet: '#2a2b3d',   // Space Dark — Quiet pulse container
  pulseActive: '#818cf8',  // Active Pulse
  pulseAlert: '#f43f5e',   // Alert Pulse
  toolShell: '#7dd3fc',    // Sky Azure — bash/grep/glob
  toolEdit: '#c084fc',     // Nebula Violet — edit_file/write_file
  toolTest: '#34d399',     // Aurora Mint — run_tests
  toolDelegate: '#fbbf24', // Stellar Amber — delegate
}

const GEMINI_FALLBACK: ColorSet = {
  primary: 'blueBright',
  secondary: 'magentaBright',
  success: 'cyanBright',
  warning: 'yellowBright',
  error: 'redBright',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blueBright',
  pulseAlert: 'redBright',
}

function makeToolColor(c: ColorSet) {
  return (name: string): string => {
    switch (name) {
      // 探索族（shell）：bash / grep / glob / read / semantic / repo 等
      case 'bash': case 'grep': case 'glob':
      case 'read_file': case 'read_section': case 'read_policy':
      case 'semantic_search': case 'repo_map': case 'repo_graph':
      case 'inspect_project': case 'related_tests': case 'file_info': case 'ls':
        return c.toolShell ?? c.primary
      case 'edit_file': case 'write_file': case 'hash_edit': case 'apply_patch':
        return c.toolEdit ?? c.secondary
      case 'run_tests': return c.toolTest ?? c.success
      case 'delegate_task': case 'delegate_batch': return c.toolDelegate ?? c.warning
      default: return c.toolShell ?? c.dim
    }
  }
}

function makeContextColor(c: Pick<ColorSet, 'dim' | 'warning' | 'error'>) {
  return (pct: number): string => {
    if (pct >= 0.88) return c.error
    if (pct >= 0.75) return c.warning
    return c.dim
  }
}

function buildTheme(colors: ColorSet, overrides?: { userColor?: string; assistantColor?: string; muted?: string; systemColor?: string }): RivetTheme {
  return {
    ...colors,
    muted: overrides?.muted ?? '#9aa2b1',
    userColor: overrides?.userColor ?? colors.primary,
    assistantColor: overrides?.assistantColor ?? colors.secondary,
    systemColor: overrides?.systemColor ?? '#9aa2b1',
    toolColor: makeToolColor(colors),
    contextColor: makeContextColor(colors),
  }
}

export const THEMES: Record<ThemeName, { truecolor: RivetTheme; fallback: RivetTheme }> = {
  pastel: {
    truecolor: buildTheme(PASTEL_TRUECOLOR),
    fallback: buildTheme(PASTEL_FALLBACK),
  },
  cyberpunk: {
    truecolor: buildTheme(CYBERPUNK_TRUECOLOR),
    fallback: buildTheme(CYBERPUNK_FALLBACK),
  },
  observatory: {
    truecolor: buildTheme(OBSERVATORY_TRUECOLOR),
    fallback: buildTheme(OBSERVATORY_FALLBACK),
  },
  midnight: {
    truecolor: buildTheme(MIDNIGHT_TRUECOLOR, { userColor: '#e6edf3', assistantColor: '#e6edf3' }),
    fallback: buildTheme(MIDNIGHT_FALLBACK, { userColor: 'white', assistantColor: 'white' }),
  },
  starfield: {
    truecolor: buildTheme(STARFIELD_TRUECOLOR, { userColor: '#e8ecf8', assistantColor: '#c9a9ff', muted: '#aab4d4' }),
    fallback: buildTheme(STARFIELD_FALLBACK, { userColor: 'white', assistantColor: 'magenta' }),
  },
  tianshu: {
    // userColor = 朱砂印 cinnabar (the user ▌ mark, the one warm point);
    // assistantColor = bright neutral body text (贴近设计稿 --fg-hi #d8dae2);
    // muted = 元信息灰 (提亮 ~6.5:1，深色背景可读);
    // systemColor = 与 muted 对齐 (系统消息/元信息一致性).
    truecolor: buildTheme(TIANSHU_TRUECOLOR, { userColor: '#d4453a', assistantColor: '#d2d5dd', muted: '#adb2bf', systemColor: '#adb2bf' }),
    fallback: buildTheme(TIANSHU_FALLBACK, { userColor: 'red', assistantColor: 'white' }),
  },
  claude: {
    // userColor = Claude brand orange (matches primary — user ▌ mark reuses brand hue);
    // assistantColor = Claude text rgb(217,217,217) neutral gray-white — the assistant
    //   body is NOT violet in upstream; autoAccept violet is a small badge only.
    //   Using violet for the full message body clashed with amber warning tools.
    // muted = Claude `inactive` rgb(153,153,153) → #999999.
    truecolor: buildTheme(CLAUDE_TRUECOLOR, { userColor: '#d77757', assistantColor: '#d9d9d9', muted: '#999999' }),
    fallback: buildTheme(CLAUDE_FALLBACK, { userColor: 'redBright', assistantColor: 'white' }),
  },
  ziwei: {
    // userColor = 朱砂印 cinnabar (the user ▌ mark, the one warm point)
    // assistantColor = 紫微紫 primary
    // muted = 远星灰
    truecolor: buildTheme(ZIWEI_TRUECOLOR, { userColor: '#d4453a', assistantColor: '#c9b8ff', muted: '#9aa2b1' }),
    fallback: buildTheme(ZIWEI_FALLBACK, { userColor: 'red', assistantColor: 'magenta', muted: 'white' }),
  },
  slate: {
    // userColor = 干净中性亮白：用户 ▌ 标记不抢色（专业、不花哨）
    // assistantColor = 柔中性灰：正文降眩光、不疲劳
    // muted = 元信息灰
    truecolor: buildTheme(SLATE_TRUECOLOR, { userColor: '#e2e6ec', assistantColor: '#c4c9d2', muted: '#8b93a3' }),
    fallback: buildTheme(SLATE_FALLBACK, { userColor: 'white', assistantColor: 'white', muted: 'gray' }),
  },
  antigravity: {
    // userColor = 干净中性亮白 ▌ 标记，不抢 accent 蓝
    // assistantColor = 柔中性灰正文 (desktop --text 降档)
    // muted = 桌面端 --muted 灰
    truecolor: buildTheme(ANTIGRAVITY_TRUECOLOR, { userColor: '#e2e6ec', assistantColor: '#c4c9d2', muted: '#989aa6' }),
    fallback: buildTheme(ANTIGRAVITY_FALLBACK, { userColor: 'white', assistantColor: 'white', muted: 'gray' }),
  },
  cobalt: {
    // userColor = 冷调亮白 ▌ 标记 (--tui-bright)，不抢 accent 钴蓝
    // assistantColor = 冷中性灰正文 (--tui-fg)，降眩光不疲劳
    // muted = 元信息灰 (--tui-label)
    truecolor: buildTheme(COBALT_TRUECOLOR, { userColor: '#e6ecf2', assistantColor: '#c9cfd6', muted: '#9ca5b3' }),
    fallback: buildTheme(COBALT_FALLBACK, { userColor: 'white', assistantColor: 'white', muted: 'gray' }),
  },
  gemini: {
    // userColor = 亮靛白 ▌ 标记
    // assistantColor = 柔中性灰正文
    // muted = 星云灰
    truecolor: buildTheme(GEMINI_TRUECOLOR, { userColor: '#e0e7ff', assistantColor: '#c4c9d2', muted: '#9497a6' }),
    fallback: buildTheme(GEMINI_FALLBACK, { userColor: 'white', assistantColor: 'white', muted: 'gray' }),
  },
}

let activeTheme: ThemeName = 'cobalt'

export function setTheme(name: ThemeName): void {
  activeTheme = name
}

export function getActiveThemeName(): ThemeName {
  return activeTheme
}

export function getTheme(colorLevel?: number): RivetTheme {
  const level = colorLevel ?? chalk.level
  const theme = THEMES[activeTheme]
  return level >= 3 ? theme.truecolor : theme.fallback
}
