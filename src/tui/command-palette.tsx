import { useState } from 'react'
import { Box, Text, useInput } from 'ink'

export interface PaletteCommand {
  name: string
  description: string
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query) return [...commands]
  const lower = query.toLowerCase()
  return commands
    .filter(c => {
      if (c.name.toLowerCase().includes(lower)) return true
      if (c.description.toLowerCase().includes(lower)) return true
      // Fuzzy subsequence match
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

  const filtered = filterCommands(commands, query)

  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">▎{query || 'Type to search...'}</Text>
      <Box flexDirection="column" marginTop={1}>
        {filtered.slice(0, 10).map((cmd, i) => (
          <Box key={cmd.name}>
            <Text color={i === selectedIdx ? 'green' : undefined}>
              {i === selectedIdx ? '❯ ' : '  '}
              <Text bold={i === selectedIdx}>{cmd.name}</Text>
              <Text dimColor> — {cmd.description}</Text>
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export function getPaletteCommands(): PaletteCommand[] {
  return [
    { name: '/help', description: 'Show all commands' },
    { name: '/compact', description: 'Compact conversation context' },
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
    { name: '/mcp', description: 'Show MCP server status' },
    { name: '/cockpit', description: 'Toggle cockpit panel' },
    { name: '/scroll', description: 'Browse output history' },
    { name: '/theme', description: 'Switch color theme' },
    { name: '/fork', description: 'Fork current session' },
    { name: '/vim', description: 'Toggle vim keybindings' },
    { name: '/effort', description: 'Set reasoning effort (off|low|medium|high|max)' },
    { name: '/interview', description: 'Deep interview to clarify requirements' },
    { name: '/exit', description: 'Save session and exit' },
  ]
}
