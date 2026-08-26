/**
 * 座舱斜杠分流 — 纯函数，零宿主依赖。
 *
 * sidecar POST /prompt 只翻译生态命令（/plan 带任务、/team、/review…）。
 * /yes /permission /handoff 等 TUI 本地命令在那边是 400。这里先拦下来，
 * 能映射 REST 的本地落地，其余给友好说明，避免消息被拒。
 */

export type ApprovalWire = 'manual' | 'auto-safe' | 'dangerously-skip-permissions'

export const EFFORT_LEVELS = ['auto', 'off', 'low', 'medium', 'high', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v)
}

export type LocalSlash =
  | { kind: 'approval'; mode: ApprovalWire }
  | { kind: 'plan-mode'; state: 'planning' | 'off' }
  | { kind: 'ask-mode'; state: 'asking' | 'off' }
  | { kind: 'resume' }
  | { kind: 'handoff'; note?: string }
  | { kind: 'effort'; level: EffortLevel }
  | { kind: 'passthrough' }
  | { kind: 'blocked'; message: string }

export interface SlashMenuItem {
  name: string
  desc: string
}

export const SLASH_MENU: readonly SlashMenuItem[] = [
  { name: '/yes', desc: '一键全自动（免审批；写沙箱仍开）' },
  { name: '/yes off', desc: '回到自动档' },
  { name: '/permission supervise', desc: '监督 · 每个高风险工具都确认' },
  { name: '/permission auto', desc: '自动 · 低风险自动、高风险仍问' },
  { name: '/permission unattended', desc: '全自动 · 项目内免审批' },
  { name: '/plan', desc: '写实现计划（后接任务描述）' },
  { name: '/plan-mode', desc: '进入计划模式（只读规划）' },
  { name: '/ask', desc: '进入询问模式（只读问答，不改文件）' },
  { name: '/review', desc: 'L2 审查当前未提交改动' },
  { name: '/review max', desc: 'L3 五人编队审查' },
  { name: '/team', desc: '团队分波并行实现（后接任务）' },
  { name: '/council', desc: '议事会会诊（后接目标）' },
  { name: '/scout', desc: '只读巡天侦察（后接目标）' },
  { name: '/handoff', desc: '写交接文档并归档' },
  { name: '/resume', desc: '续跑当前会话' },
  { name: '/effort', desc: '推理强度 auto|off|low|medium|high|max' },
  { name: '/rewind', desc: '退到某条用户消息之前' },
]

const NEEDS_ARGS = new Set(['/team', '/plan', '/write-plan', '/council', '/scout', '/galaxy', '/starflow', '/effort'])

const PASSTHROUGH = new Set([
  'write-plan',
  'team',
  'council',
  'review',
  'scout',
  'galaxy',
  'starflow',
  'skill',
])

/** 行首 `/` 且尚无空白 → 命令菜单态。返回 `/` 后面的查询（可空）。 */
export function detectSlashToken(text: string): string | null {
  if (!text.startsWith('/')) return null
  if (/\s/.test(text)) return null
  return text.slice(1)
}

export function filterSlashMenu(query: string): SlashMenuItem[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  if (!q) return [...SLASH_MENU]
  return SLASH_MENU.filter(
    (c) => c.name.slice(1).toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
  )
}

export function slashNeedsArgs(name: string): boolean {
  return NEEDS_ARGS.has(name.trim())
}

export function resolveComposerSlash(text: string): LocalSlash {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return { kind: 'passthrough' }

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean)
  const cmd = (parts[0] ?? '').toLowerCase()
  const rest = parts.slice(1)
  const note = rest.join(' ') || undefined

  switch (cmd) {
    case 'yes':
      if (!rest[0] || rest[0]!.toLowerCase() === 'on') {
        return { kind: 'approval', mode: 'dangerously-skip-permissions' }
      }
      if (rest[0]!.toLowerCase() === 'off') return { kind: 'approval', mode: 'auto-safe' }
      return { kind: 'blocked', message: '用法: /yes 或 /yes off' }
    case 'permission':
      return resolvePermission(rest)
    case 'resume':
      return { kind: 'resume' }
    case 'handoff':
      return { kind: 'handoff', note }
    case 'plan-mode':
      return { kind: 'plan-mode', state: 'planning' }
    case 'ask':
      if ((rest[0] ?? '').toLowerCase() === 'off') return { kind: 'ask-mode', state: 'off' }
      return { kind: 'ask-mode', state: 'asking' }
    case 'plan':
      return rest.length === 0 ? { kind: 'plan-mode', state: 'planning' } : { kind: 'passthrough' }
    case 'compact':
      return { kind: 'blocked', message: 'sidecar 无压缩路由，请在 TUI 用 /compact。' }
    case 'model':
    case 'domain':
      return { kind: 'blocked', message: '用工具栏切换模型 / 星域。' }
    case 'rewind':
    case 'undo':
      return { kind: 'blocked', message: '点用户消息上的「退到这里」。' }
    case 'rollback':
      return { kind: 'blocked', message: '回滚请用资源管理器「天枢变更」标题栏的回滚按钮。' }
    case 'steer':
      return { kind: 'blocked', message: '运行中直接发送=排队；要立刻打断点排队卡上的「立即插话」。' }
    case 'theme':
    case 'vim':
    case 'config':
    case 'connect':
      return { kind: 'blocked', message: `/${cmd} 是 TUI 本地命令，插件暂不支持。` }
    case 'effort': {
      const level = (rest[0] ?? '').toLowerCase()
      if (!level) return { kind: 'blocked', message: '用法: /effort auto|off|low|medium|high|max（也可点工具栏）' }
      if (!isEffortLevel(level)) return { kind: 'blocked', message: '用法: /effort auto|off|low|medium|high|max' }
      return { kind: 'effort', level }
    }
    case 'mcp':
    case 'goal':
    case 'cd':
    case 'fork':
    case 'clear':
    case 'sessions':
    case 'chat':
    case 'verbose':
    case 'cockpit':
      return { kind: 'blocked', message: `/${cmd} 是 TUI 本地命令，插件暂不支持。` }
    default:
      if (PASSTHROUGH.has(cmd)) return { kind: 'passthrough' }
      return { kind: 'blocked', message: `未知命令 /${cmd}。输入 / 打开命令菜单，或直接发普通消息。` }
  }
}

function resolvePermission(rest: string[]): LocalSlash {
  if (rest.length === 0) {
    return { kind: 'blocked', message: '用法: /permission supervise | auto | unattended（也可点工具栏）。' }
  }
  const head = rest[0]!.toLowerCase()
  if (head === 'supervise' || head === 'manual') return { kind: 'approval', mode: 'manual' }
  if (head === 'auto' || head === 'default') return { kind: 'approval', mode: 'auto-safe' }
  if (head === 'unattended' || head === 'yolo' || head === 'autonomous' || head === 'yes') {
    return { kind: 'approval', mode: 'dangerously-skip-permissions' }
  }
  if (head === 'mode') {
    const mode = rest[1]
    if (mode === 'manual' || mode === 'auto-safe' || mode === 'dangerously-skip-permissions') {
      return { kind: 'approval', mode }
    }
    if (mode === 'auto-accept') return { kind: 'approval', mode: 'auto-safe' }
  }
  return { kind: 'blocked', message: '用法: /permission supervise | auto | unattended' }
}
