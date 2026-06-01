import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from './theme.js'
import type { LogEntry } from './log-state.js'
import { renderStaticEntry } from './render-entry.js'

const PAGE_SIZE = 15

interface PagerProps {
  entries: LogEntry[]
  verbose: boolean
  onExit: () => void
}

export function Pager({ entries, verbose, onExit }: PagerProps) {
  const theme = getTheme()
  const total = entries.length
  const [offset, setOffset] = useState(Math.max(0, total - PAGE_SIZE))

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === '\x10')) {
      onExit()
      return
    }
    if (key.upArrow || input === 'k') {
      setOffset(o => Math.max(0, o - 1))
    }
    if (key.downArrow || input === 'j') {
      setOffset(o => Math.min(total - 1, o + 1))
    }
    if (key.pageUp || input === 'b') {
      setOffset(o => Math.max(0, o - PAGE_SIZE))
    }
    if (key.pageDown || input === ' ') {
      setOffset(o => Math.min(total - 1, o + PAGE_SIZE))
    }
    if (input === 'g') {
      setOffset(0)
    }
    if (input === 'G') {
      setOffset(Math.max(0, total - PAGE_SIZE))
    }
  })

  const visible = entries.slice(offset, offset + PAGE_SIZE)
  const pct = total > 0 ? Math.round(((offset + PAGE_SIZE) / total) * 100) : 100

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1}>
      <Text bold color={theme.primary}>
        ── Scrollback ({total} entries) ── {offset + 1}-{Math.min(offset + PAGE_SIZE, total)}/{total} ({pct}%)
      </Text>
      <Box flexDirection="column">
        {visible.map(entry => renderStaticEntry(entry, verbose))}
      </Box>
      <Text color={theme.muted}>
        ↑↓/j/k: scroll · PgUp/PgDn: page · g/G: top/bottom · q/Esc: close
      </Text>
    </Box>
  )
}

// --- Scroll buffer for history ---

const SCROLL_BUFFER_SIZE = 500

export class ScrollBuffer {
  private entries: LogEntry[] = []
  private maxSize: number

  constructor(maxSize = SCROLL_BUFFER_SIZE) {
    this.maxSize = maxSize
  }

  push(entry: LogEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize)
    }
  }

  getEntries(): LogEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
  }

  get length(): number {
    return this.entries.length
  }
}
