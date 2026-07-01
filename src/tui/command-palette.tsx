import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from './theme.js'

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

interface CommandPaletteProps {
  commands: PaletteCommand[]
  onSelect: (name: string) => void
  onCancel: () => void
}

export function CommandPalette({ commands, onSelect, onCancel }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const theme = getTheme()

  const filtered = filterCommands(commands, query)

  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    const hotkeyMatch = filtered.find(c => c.category === 'surface' && c.hotkey === _input)
    if (hotkeyMatch) {
      onSelect(hotkeyMatch.name)
      return
    }
    if (key.return && filtered.length > 0) {
      onSelect(filtered[selectedIdx]!.name)
      return
    }
    if (key.upArrow) {
      setSelectedIdx(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIdx(prev => Math.min(filtered.length - 1, prev + 1))
      return
    }
    if (key.backspace || key.delete) {
      setQuery(prev => prev.slice(0, -1))
      setSelectedIdx(0)
      return
    }
    if (_input.length === 1) {
      setQuery(prev => prev + _input)
      setSelectedIdx(0)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color={theme.primary} bold>&gt; </Text>
        <Text color={query ? theme.userColor : theme.dim}>{query || 'search commands...'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.slice(0, 10).map((cmd, i) => {
          const isSelected = i === selectedIdx
          return (
            <Box key={cmd.name}>
              <Text color={isSelected ? theme.primary : theme.dim}>{isSelected ? '>' : ' '} </Text>
              <Text color={isSelected ? theme.primary : theme.secondary} bold={isSelected}>{cmd.name}</Text>
              {cmd.hotkey && <Text color={theme.dim}> [{cmd.hotkey}]</Text>}
              <Text color={theme.dim}> {cmd.description}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
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
    { name: '/permission', description: 'Manage permission mode and rules' },
    { name: '/yes', description: 'YOLO 模式 — 一键跳过所有审批（再次输入关闭）' },
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
    { name: '/plan-mode', description: 'Enter plan authoring mode (write operations blocked)' },
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
  ]
}
