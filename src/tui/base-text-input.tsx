import React, { useState, useCallback, useRef } from 'react'
import { VimState as VimStateClass, processVimKey } from './vim-mode.js'
import { Text } from 'ink'
import { useInput } from 'ink'

// Bracketed paste markers (after Ink strips leading \x1b)
const PASTE_START = '[200~'
const PASTE_END = '[201~'

interface BaseTextInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  history?: string[]
  vimEnabled?: boolean
}

/** Get line/column info from a flat cursor position in a multi-line string */
function getLineCol(text: string, pos: number): { line: number; col: number } {
  let line = 0
  let col = 0
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      col = 0
    } else {
      col++
    }
  }
  return { line, col }
}

/** Get flat position from line/column */
function posFromLineCol(lines: string[], line: number, col: number): number {
  let pos = 0
  for (let i = 0; i < line && i < lines.length; i++) {
    pos += (lines[i]?.length ?? 0) + 1 // +1 for \n
  }
  if (line < lines.length) {
    pos += Math.min(col, lines[line]!.length)
  }
  return pos
}

export function BaseTextInput({ value, onChange, onSubmit, disabled, placeholder, history, vimEnabled }: BaseTextInputProps) {
  const [cursorPos, setCursorPos] = useState(0)
  const [cursorShown, setCursorShown] = useState(true)
  const historyIndexRef = useRef(-1)
  const savedInputRef = useRef('')
  const vimRef = useRef(new VimStateClass())

  // Bracketed paste state
  const isPastingRef = useRef(false)
  const pasteBufferRef = useRef('')
  // Rapid-return detection for terminals without bracketed paste
  const lastInputTimeRef = useRef(0)

  // Enable bracketed paste mode
  React.useEffect(() => {
    process.stdout.write('\x1b[?2004h')
    return () => {
      process.stdout.write('\x1b[?2004l')
    }
  }, [])

  React.useEffect(() => {
    if (disabled) return
    const id = setInterval(() => setCursorShown(v => !v), 530)
    return () => clearInterval(id)
  }, [disabled])

  // Keep cursor within bounds when value changes externally
  React.useEffect(() => {
    setCursorPos(prev => Math.min(prev, value.length))
  }, [value.length])

  const MAX_INPUT_LENGTH = 100_000

  const insertAtCursor = useCallback((insertion: string) => {
    const normalized = insertion.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const available = MAX_INPUT_LENGTH - value.length
    if (available <= 0) return
    const truncated = normalized.slice(0, available)
    onChange(value.slice(0, cursorPos) + truncated + value.slice(cursorPos))
    setCursorPos(prev => prev + truncated.length)
  }, [value, cursorPos, onChange])

  const MAX_PASTE_LENGTH = 50_000

  const flushPasteBuffer = useCallback(() => {
    if (pasteBufferRef.current) {
      const normalized = pasteBufferRef.current.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const available = MAX_INPUT_LENGTH - value.length
      const truncated = available > 0 ? normalized.slice(0, Math.min(available, MAX_PASTE_LENGTH)) : ''
      onChange(value.slice(0, cursorPos) + truncated + value.slice(cursorPos))
      setCursorPos(prev => prev + truncated.length)
      pasteBufferRef.current = ''
    }
    isPastingRef.current = false
  }, [value, cursorPos, onChange])

  const hasMultipleLines = value.includes('\n')

  useInput((input, key) => {
    if (disabled) return

    // Bracketed paste handling
    if (input === PASTE_START) {
      isPastingRef.current = true
      pasteBufferRef.current = ''
      return
    }
    if (input === PASTE_END) {
      flushPasteBuffer()
      return
    }
    if (isPastingRef.current) {
      if (pasteBufferRef.current.length < MAX_PASTE_LENGTH) {
        pasteBufferRef.current += input
      }
      return
    }

    // Multi-line navigation — Up/Down arrows move between lines
    if (key.upArrow) {
      if (hasMultipleLines) {
        const lines = value.split('\n')
        const { line, col } = getLineCol(value, cursorPos)
        if (line > 0) {
          setCursorPos(posFromLineCol(lines, line - 1, col))
        }
        return
      }
      if (history && history.length > 0) {
        if (historyIndexRef.current < history.length - 1) {
          if (historyIndexRef.current === -1) savedInputRef.current = value
          historyIndexRef.current++
          const entry = history[historyIndexRef.current]!
          onChange(entry)
          setCursorPos(entry.length)
        }
        return
      }
      return
    }
    if (key.downArrow) {
      if (hasMultipleLines) {
        const lines = value.split('\n')
        const { line, col } = getLineCol(value, cursorPos)
        if (line < lines.length - 1) {
          setCursorPos(posFromLineCol(lines, line + 1, col))
        }
        return
      }
      if (historyIndexRef.current >= 0) {
        historyIndexRef.current--
        const restored = historyIndexRef.current === -1
          ? savedInputRef.current
          : history![historyIndexRef.current]!
        onChange(restored)
        setCursorPos(restored.length)
      }
      return
    }

    // Reset history index on any other key
    if (historyIndexRef.current !== -1) {
      historyIndexRef.current = -1
      savedInputRef.current = ''
    }

    // Enter — submit (Alt/Option+Enter inserts newline instead)
    // Rapid-return fallback: if Enter comes <50ms after last input, treat as paste newline
    if (key.return) {
      if (key.meta) {
        insertAtCursor('\n')
        return
      }
      const now = Date.now()
      if (now - lastInputTimeRef.current < 50 && hasMultipleLines) {
        insertAtCursor('\n')
        lastInputTimeRef.current = now
        return
      }
      onSubmit(value)
      setCursorPos(0)
      return
    }

    // Track input timing for rapid-return detection
    lastInputTimeRef.current = Date.now()

    // Ctrl+N — insert newline (fallback for terminals where Alt+Enter = Enter)
    if (key.ctrl && input === 'n') {
      insertAtCursor('\n')
      return
    }

    // Arrow keys — cursor movement
    if (key.leftArrow) {
      setCursorPos(prev => Math.max(0, prev - 1))
      return
    }
    if (key.rightArrow) {
      setCursorPos(prev => Math.min(value.length, prev + 1))
      return
    }
    // Home — move to start of current line
    if (key.home || (key.ctrl && input === 'a')) {
      if (hasMultipleLines) {
        const { line } = getLineCol(value, cursorPos)
        const lines = value.split('\n')
        setCursorPos(posFromLineCol(lines, line, 0))
      } else {
        setCursorPos(0)
      }
      return
    }
    // End — move to end of current line
    if (key.end || (key.ctrl && input === 'e')) {
      if (hasMultipleLines) {
        const { line } = getLineCol(value, cursorPos)
        const lines = value.split('\n')
        setCursorPos(posFromLineCol(lines, line, lines[line]!.length))
      } else {
        setCursorPos(value.length)
      }
      return
    }

    // Backspace / Delete — macOS backspace sends \x7f which Ink maps to key.delete,
    // so treat both as backward delete.
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        onChange(value.slice(0, cursorPos - 1) + value.slice(cursorPos))
        setCursorPos(prev => prev - 1)
      }
      return
    }

    // Ctrl+U — clear current line
    if (key.ctrl && (input === 'u' || input === 'U')) {
      if (hasMultipleLines) {
        const { line } = getLineCol(value, cursorPos)
        const lines = value.split('\n')
        const lineStart = posFromLineCol(lines, line, 0)
        onChange(value.slice(0, lineStart) + value.slice(cursorPos))
        setCursorPos(lineStart)
      } else {
        onChange('')
        setCursorPos(0)
      }
      return
    }

    // Ctrl+W — delete word backward
    if (key.ctrl && (input === 'w' || input === 'W')) {
      const before = value.slice(0, cursorPos)
      const wordEnd = before.search(/\S\s*$/)
      const cutPos = wordEnd === -1 ? 0 : wordEnd + 1
      onChange(value.slice(0, cutPos) + value.slice(cursorPos))
      setCursorPos(cutPos)
      return
    }

    // Normal character input (single char or IME multibyte)
    if (input && !key.ctrl && !key.meta) {
      insertAtCursor(input)
      return
    }
  })

  // Render cursor: show visible symbol when on \n
  const before = value.slice(0, cursorPos)
  const rawAt = value[cursorPos]
  const at = rawAt === '\n' ? '↵' : (rawAt ?? ' ')
  const after = rawAt === '\n' ? value.slice(cursorPos + 1) : value.slice(cursorPos + 1)

  return (
    <Text>
      {value.length > 0 ? (
        <>
          <Text>{before}</Text>
          <Text bold backgroundColor={cursorShown ? 'white' : undefined} color={cursorShown ? 'black' : undefined}>
            {at}
          </Text>
          <Text>{after}</Text>
        </>
      ) : (
        <Text dimColor>{placeholder ?? ''}{cursorShown ? '█' : ' '}</Text>
      )}
    </Text>
  )
}
