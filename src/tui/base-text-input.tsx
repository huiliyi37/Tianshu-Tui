import React, { useState, useCallback, useRef } from 'react'
import { VimState as VimStateClass, processVimKey } from './vim-mode.js'
import { Text } from 'ink'
import { useInput } from 'ink'
import { getTheme } from './theme.js'

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
  onTabComplete?: () => boolean
  isSlashMode?: boolean
  slashSelectedIdx?: number
  slashFilteredCount?: number
  onSlashNavigate?: (idx: number) => void
}

/** Find the start position of the word preceding `pos` in `text`.
 *  Word = maximal run of [a-zA-Z0-9_]. Stops at whitespace or non-word chars.
 *  Returns `pos` itself if no word boundary exists to the left.
 */
function prevWordStart(text: string, pos: number): number {
  if (pos <= 0) return 0
  let i = pos - 1
  // Skip current run of non-word (so "ab |cd" jumps past space to "c")
  while (i > 0 && !/\w/.test(text[i] ?? '')) i--
  // Then walk to the start of the word
  while (i > 0 && /\w/.test(text[i - 1] ?? '')) i--
  return i
}

/** Find the end position of the word following `pos` in `text`.
 *  Returns `pos` itself when no word boundary exists to the right — callers
 *  (e.g. Option+Delete) use this to detect a no-op and avoid swallowing the
 *  trailing punctuation.
 */
function nextWordEnd(text: string, pos: number): number {
  if (pos >= text.length) return pos
  let i = pos
  // Skip non-word chars
  while (i < text.length && !/\w/.test(text[i] ?? '')) i++
  if (i >= text.length) return pos
  // Walk to end of word
  while (i < text.length && /\w/.test(text[i] ?? '')) i++
  return i
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

export function BaseTextInput({ value, onChange, onSubmit, disabled, placeholder, history, vimEnabled, onTabComplete, isSlashMode, slashSelectedIdx = 0, slashFilteredCount = 0, onSlashNavigate }: BaseTextInputProps) {
  const [cursorPos, setCursorPos] = useState(0)
  const [cursorShown, setCursorShown] = useState(true)
  const historyIndexRef = useRef(-1)
  const savedInputRef = useRef('')
  const vimRef = useRef(new VimStateClass())

  // Mirror props/state into refs so the useInput handler always reads the
  // latest value (avoids stale-closure race that drops keystrokes when the
  // render thread is busy with stream chunks).
  const valueRef = useRef(value)
  const cursorPosRef = useRef(cursorPos)

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

  // Sync refs with the latest state/props so useInput handlers see fresh data
  // on every keystroke, even when multiple arrive between React renders.
  React.useEffect(() => {
    valueRef.current = value
  }, [value])
  React.useEffect(() => {
    cursorPosRef.current = cursorPos
  }, [cursorPos])

  const MAX_INPUT_LENGTH = 100_000
  const MAX_PASTE_LENGTH = 50_000

  /** Atomically update the input buffer + cursor in both refs and state.
   *  Reading from refs (not closure) keeps multi-keystroke bursts lossless
   *  when the render thread is busy (e.g. during stream chunk rendering).
   */
  const commitEdit = useCallback((newValue: string, newCursor: number) => {
    valueRef.current = newValue
    cursorPosRef.current = newCursor
    onChange(newValue)
    setCursorPos(newCursor)
  }, [onChange])

  /** Move cursor without editing text — updates both state and ref so the
   *  next useInput call reads the correct position even between renders. */
  const moveCursor = useCallback((newPos: number) => {
    cursorPosRef.current = newPos
    setCursorPos(newPos)
  }, [])

  const insertAtCursor = useCallback((insertion: string) => {
    const normalized = insertion.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const cur = valueRef.current
    const pos = cursorPosRef.current
    const available = MAX_INPUT_LENGTH - cur.length
    if (available <= 0) return
    const truncated = normalized.slice(0, available)
    commitEdit(cur.slice(0, pos) + truncated + cur.slice(pos), pos + truncated.length)
  }, [commitEdit])

  const flushPasteBuffer = useCallback(() => {
    if (pasteBufferRef.current) {
      const normalized = pasteBufferRef.current.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const cur = valueRef.current
      const pos = cursorPosRef.current
      const available = MAX_INPUT_LENGTH - cur.length
      const truncated = available > 0 ? normalized.slice(0, Math.min(available, MAX_PASTE_LENGTH)) : ''
      commitEdit(cur.slice(0, pos) + truncated + cur.slice(pos), pos + truncated.length)
      pasteBufferRef.current = ''
    }
    isPastingRef.current = false
  }, [commitEdit])

  useInput((input, key) => {
    if (disabled) return

    // Read fresh value/cursor from refs — closure may be stale when stream
    // chunks are competing for the render thread.
    const cur = valueRef.current
    const pos = cursorPosRef.current
    const hasNewlines = cur.includes('\n')

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
      if (isSlashMode && onSlashNavigate && slashFilteredCount > 0) {
        onSlashNavigate(Math.max(0, slashSelectedIdx - 1))
        return
      }
      if (hasNewlines) {
        const lines = cur.split('\n')
        const { line, col } = getLineCol(cur, pos)
        if (line > 0) {
          moveCursor(posFromLineCol(lines, line - 1, col))
          return
        }
        // At first line — fall through to history
      }
      if (history && history.length > 0) {
        if (historyIndexRef.current < history.length - 1) {
          if (historyIndexRef.current === -1) savedInputRef.current = cur
          historyIndexRef.current++
          const entry = history[historyIndexRef.current]!
          commitEdit(entry, entry.length)
        }
        return
      }
      return
    }
    if (key.downArrow) {
      if (isSlashMode && onSlashNavigate && slashFilteredCount > 0) {
        onSlashNavigate(Math.min(slashFilteredCount - 1, slashSelectedIdx + 1))
        return
      }
      if (hasNewlines) {
        const lines = cur.split('\n')
        const { line, col } = getLineCol(cur, pos)
        if (line < lines.length - 1) {
          moveCursor(posFromLineCol(lines, line + 1, col))
          return
        }
        // At last line — fall through to history
      }
      if (historyIndexRef.current >= 0) {
        historyIndexRef.current--
        const restored = historyIndexRef.current === -1
          ? savedInputRef.current
          : history![historyIndexRef.current]!
        commitEdit(restored, restored.length)
      }
      return
    }

    // Tab — slash command completion
    if (key.tab) {
      if (onTabComplete && onTabComplete()) return
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
      if (now - lastInputTimeRef.current < 50 && hasNewlines) {
        insertAtCursor('\n')
        lastInputTimeRef.current = now
        return
      }
      onSubmit(cur)
      moveCursor(0)
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
      moveCursor(Math.max(0, pos - 1))
      return
    }
    if (key.rightArrow) {
      moveCursor(Math.min(cur.length, pos + 1))
      return
    }
    // Home / Ctrl+A — move to start of current line
    if (key.home || (key.ctrl && input === 'a')) {
      if (hasNewlines) {
        const { line } = getLineCol(cur, pos)
        const lines = cur.split('\n')
        moveCursor(posFromLineCol(lines, line, 0))
      } else {
        moveCursor(0)
      }
      return
    }
    // End / Ctrl+E — move to end of current line
    if (key.end || (key.ctrl && input === 'e')) {
      if (hasNewlines) {
        const { line } = getLineCol(cur, pos)
        const lines = cur.split('\n')
        moveCursor(posFromLineCol(lines, line, lines[line]!.length))
      } else {
        moveCursor(cur.length)
      }
      return
    }
    // Option/Alt+Left (meta+b) — word jump backward
    if ((key.meta && (input === 'b' || input === 'B')) || (key.meta && key.leftArrow)) {
      moveCursor(prevWordStart(cur, pos))
      return
    }
    // Option/Alt+Right (meta+f) — word jump forward
    if ((key.meta && (input === 'f' || input === 'F')) || (key.meta && key.rightArrow)) {
      moveCursor(nextWordEnd(cur, pos))
      return
    }
    // Option+Home (meta+home) — jump to buffer start
    if (key.meta && key.home) {
      moveCursor(0)
      return
    }
    // Option+End (meta+end) — jump to buffer end
    if (key.meta && key.end) {
      moveCursor(cur.length)
      return
    }

    // Option+Backspace (meta+backspace) — delete word backward (must precede plain backspace)
    if (key.meta && key.backspace) {
      const cut = prevWordStart(cur, pos)
      if (cut !== pos) commitEdit(cur.slice(0, cut) + cur.slice(pos), cut)
      return
    }
    // Option+Delete / Ctrl+Delete (meta+delete or ctrl+delete) — delete word forward (must precede plain delete)
    if ((key.meta || key.ctrl) && key.delete) {
      const cut = nextWordEnd(cur, pos)
      if (cut !== pos) commitEdit(cur.slice(0, pos) + cur.slice(cut), pos)
      return
    }
    // Backspace / Delete — macOS backspace sends \x7f which Ink maps to key.delete,
    // so treat both as backward delete.
    if (key.backspace || key.delete) {
      if (pos > 0) {
        commitEdit(cur.slice(0, pos - 1) + cur.slice(pos), pos - 1)
      }
      return
    }

    // Ctrl+U — clear current line
    if (key.ctrl && (input === 'u' || input === 'U')) {
      if (hasNewlines) {
        const { line } = getLineCol(cur, pos)
        const lines = cur.split('\n')
        const lineStart = posFromLineCol(lines, line, 0)
        commitEdit(cur.slice(0, lineStart) + cur.slice(pos), lineStart)
      } else {
        commitEdit('', 0)
      }
      return
    }

    // Ctrl+W — delete word backward
    if (key.ctrl && (input === 'w' || input === 'W')) {
      const cut = prevWordStart(cur, pos)
      if (cut !== pos) commitEdit(cur.slice(0, cut) + cur.slice(pos), cut)
      return
    }

    // Ctrl+K — kill to end of line
    if (key.ctrl && (input === 'k' || input === 'K')) {
      if (hasNewlines) {
        const { line } = getLineCol(cur, pos)
        const lines = cur.split('\n')
        const lineEnd = posFromLineCol(lines, line, lines[line]!.length)
        if (lineEnd !== pos) commitEdit(cur.slice(0, pos) + cur.slice(lineEnd), pos)
      } else {
        if (pos !== cur.length) commitEdit(cur.slice(0, pos), pos)
      }
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
          {value.startsWith('/') ? (
            <>
              <Text color="cyan">{before}</Text>
              <Text bold backgroundColor={cursorShown ? 'white' : undefined} color={cursorShown ? 'black' : undefined}>
                {at}
              </Text>
              <Text color="cyan">{after}</Text>
            </>
          ) : (
            <>
              <Text>{before}</Text>
              <Text bold backgroundColor={cursorShown ? 'white' : undefined} color={cursorShown ? 'black' : undefined}>
                {at}
              </Text>
              <Text>{after}</Text>
            </>
          )}
        </>
      ) : (
        <Text color={getTheme().muted}>{placeholder ?? ''}{cursorShown ? '█' : ' '}</Text>
      )}
    </Text>
  )
}
