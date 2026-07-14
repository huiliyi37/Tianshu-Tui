/**
 * 命令面板数据层 — 命令清单与模糊过滤（纯函数，零 React/Ink）。
 *
 * 渲染与按键交互在 T9：`format/overlay.ts::renderCommandPalette` +
 * `engine/app.ts` 的 overlay 导航。本模块只提供数据。
 */

export interface PaletteCommand {
  name: string
  description: string
  category?: 'command' | 'surface'
  hotkey?: string
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query) return [...commands]
  const lower = query.toLowerCase()
  return commands
    .filter(c => {
      if (c.name.toLowerCase().includes(lower)) return true
      if (c.description.toLowerCase().includes(lower)) return true
      let qi = 0
      for (let i = 0; i < c.name.length && qi < lower.length; i++) {
        if (c.name[i]!.toLowerCase() === lower[qi]) qi++
      }
      return qi === lower.length
    })
    .sort((a, b) => {
      const aStart = a.name.toLowerCase().startsWith(lower) ? 0 : 1
      const bStart = b.name.toLowerCase().startsWith(lower) ? 0 : 1
      return aStart - bStart || a.name.localeCompare(b.name)
    })
}

export function getPaletteCommands(): PaletteCommand[] {
  return [
    { name: '__surface:cockpit', description: 'Cockpit — trace / verify / context', category: 'surface', hotkey: 'c' },
    { name: '__surface:pager', description: 'Scrollback — browse session history', category: 'surface', hotkey: 'p' },
    { name: '__surface:starmap', description: 'Starmap — 星图总览', category: 'surface', hotkey: 's' },
    { name: '__surface:chronicle', description: 'Chronicle — 阶段传说', category: 'surface', hotkey: 'h' },
    { name: '/help', description: 'Show all commands', category: 'command' },
    { name: '/compact', description: 'Compact conversation context' },
    { name: '/connect', description: '连接模型服务商（选内置或自定义，填写 API 密钥）' },
    { name: '/model', description: 'Show or switch model' },
    { name: '/model list', description: 'List available models' },
    { name: '/chat', description: 'Switch to lightweight chat mode' },
    { name: '/task', description: 'Switch to full task mode' },
    { name: '/mode', description: 'Show or switch prompt mode' },
    { name: '/verify', description: 'Show verification status' },
    { name: '/verbose', description: 'Toggle verbose tool output' },
    { name: '/clear', description: 'Clear screen' },
    { name: '/sessions', description: 'List saved sessions' },
    { name: '/resume', description: 'Restore a saved session' },
    { name: '/rollback', description: 'Preview checkpoint changes' },
    { name: '/evidence', description: 'Show last turn evidence' },
    { name: '/context', description: 'Show context ledger' },
    { name: '/memory', description: 'Show session memory' },
    { name: '/skill list', description: 'List available skills' },
    { name: '/skill install', description: 'Install skill from .claude/skills into .rivet/skills' },
    { name: '/skill review', description: 'Review auto-distilled skill drafts' },
    { name: '/skill approve', description: 'Promote a skill draft into .rivet/skills' },
    { name: '/skill reject', description: 'Reject and delete a skill draft' },
    { name: '/permission', description: '权限模式：Manual / Auto / YOLO 三档统一入口（无参弹选择器，持久化默认）' },
    { name: '/yes', description: '一键 YOLO（/yes off 退出）— 持久化为默认' },
    { name: '/mission', description: '天契 — 当前任务契约', category: 'command' },
    { name: '/goal', description: 'Set a persistent goal — agent auto-continues until achieved' },
    { name: '/cancel-goal', description: 'Cancel the active goal' },
    { name: '/goal-resume', description: 'Resume a paused or blocked goal' },
    { name: '/mcp', description: 'Show MCP server status' },
    { name: '/cockpit', description: 'Toggle cockpit panel' },
    { name: '/scroll', description: 'Browse output history' },
    { name: '/theme', description: 'Switch color theme' },
    { name: '/fork', description: 'Fork current session' },
    { name: '/vim', description: 'Toggle vim keybindings' },
    { name: '/effort', description: 'Set reasoning effort (off|low|medium|high|max)' },
    { name: '/domain', description: '查看或切换星域人格 (list|<name>|auto|off)' },
    { name: '/interview', description: 'Deep interview to clarify requirements' },
    { name: '/team', description: 'Run team-mode workflow skeleton' },
    { name: '/team max', description: 'Run team-mode planning-first workflow' },
    { name: '/council', description: 'Convene a star-domain council (single round; --rounds 2+ enables debate)' },
    { name: '/plan', description: 'Create implementation plan (writing-plans workflow)' },
    { name: '/write-plan', description: 'Alias of /plan — same writing-plans workflow' },
    { name: '/plan-mode', description: 'Enter/exit plan authoring mode (/plan-mode toggles)' },
    { name: '/ask', description: 'Enter/exit Ask mode — read-only Q&A (/ask toggles)' },
    { name: '/plan-list', description: 'List submitted plans awaiting approval' },
    { name: '/plan-approve', description: 'Approve a plan and start execution' },
    { name: '/plan-reject', description: 'Reject a plan with feedback for revision' },
    { name: '/plan-close', description: 'Preview or apply implementation plan closure' },
    { name: '/review', description: 'Trigger L2 adversarial code review on current changes' },
    { name: '/review max', description: 'Trigger L3 Review Squadron (5 inspectors) on current changes' },
    { name: '/constellation', description: '星图 — Project blueprint & milestone chronicle' },
    { name: '/leave', description: '离开仪式 — Leave your mark in the starmap' },
    { name: '/enter', description: 'Resume a worker session (e.g. /enter wo_team:T1 continue)' },
    { name: '/exit', description: 'Save session and exit' },
    { name: '/update', description: 'Check and install the latest Rivet release' },
    { name: '/doctor', description: 'Environment health check + which shell the bash tool uses' },
    { name: '/init', description: '项目指纹探测 → 生成/更新 verify 声明（.rivet-config.json + .rivet.md）' },
  ]
}
