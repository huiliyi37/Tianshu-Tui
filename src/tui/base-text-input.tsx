import React, { useState, useCallback } from 'react'
import { Text } from 'ink'
import { useInput } from 'ink'

interface BaseTextInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
}

export function BaseTextInput({ value, onChange, onSubmit, disabled, placeholder }: BaseTextInputProps) {
  const [cursorPos, setCursorPos] = useState(0)
  const [cursorShown, setCursorShown] = useState(true)

  React.useEffect(() => {
    if (disabled) return
    const id = setInterval(() => setCursorShown(v => !v), 530)
    return () => clearInterval(id)
  }, [disabled])

  // Keep cursor within bounds when value changes externally
  React.useEffect(() => {
    setCursorPos(prev => Math.min(prev, value.length))
  }, [value.length])

  const insertAtCursor = useCallback((insertion: string) => {
    onChange(value.slice(0, cursorPos) + insertion + value.slice(cursorPos))
    setCursorPos(prev => prev + insertion.length)
  }, [value, cursorPos, onChange])

  useInput((input, key) => {
    if (disabled) return

    // Enter — submit
    if (key.return) {
      onSubmit(value)
      setCursorPos(0)
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
    // Home/End
    if (key.home || (key.ctrl && input === 'a')) {
      setCursorPos(0)
      return
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setCursorPos(value.length)
      return
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      if (key.delete || key.meta) {
        // Delete forward (or word-delete)
        onChange(value.slice(0, cursorPos) + value.slice(cursorPos + 1))
      } else {
        // Backspace
        if (cursorPos > 0) {
          onChange(value.slice(0, cursorPos - 1) + value.slice(cursorPos))
          setCursorPos(prev => prev - 1)
        }
      }
      return
    }

    // Ctrl+U — clear line
    if (key.ctrl && (input === 'u' || input === 'U')) {
      onChange('')
      setCursorPos(0)
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

  const before = value.slice(0, cursorPos)
  const at = value[cursorPos] ?? ' '
  const after = value.slice(cursorPos + 1)

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
