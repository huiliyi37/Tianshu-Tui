import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text } from 'ink'
import { BaseTextInput } from './base-text-input.js'
import { loadHistory, appendHistory, nextHistoryAfterSubmit } from './history.js'
import { SlashHint } from './slash-hint.js'
import { getPaletteCommands, filterCommands } from './command-palette.js'
import { getTheme } from './theme.js'

const COMMANDS = getPaletteCommands()

/** Breathing diamond frames — subtle pulse when agent is thinking */
const PULSE_FRAMES = ['◇', '◈', '◆', '◈'] as const

interface InputBarProps {
  onSubmit: (value: string) => void
  disabled?: boolean
  vimEnabled?: boolean
  steerMode?: boolean
  inputRef?: React.MutableRefObject<{ clear: () => void; hasContent: () => boolean; setValue: (v: string) => void }>
}

export function InputBar({ onSubmit, disabled, vimEnabled, steerMode, inputRef }: InputBarProps) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState(() => loadHistory())
  const [slashIdx, setSlashIdx] = useState(0)
  const [pulseIdx, setPulseIdx] = useState(0)

  useEffect(() => {
    if (!steerMode) return
    // 1200ms/frame → 4.8s full cycle: a slow breath, not a loading spinner.
    const id = setInterval(() => setPulseIdx(i => (i + 1) % PULSE_FRAMES.length), 1200)
    return () => clearInterval(id)
  }, [steerMode])

  React.useEffect(() => {
    if (inputRef) {
      inputRef.current = {
        clear: () => setValue(''),
        hasContent: () => value.length > 0,
        setValue: (v: string) => setValue(v),
      }
    }
  })

  const isSlash = value.startsWith('/') && !value.includes('\n')
  const filtered = isSlash ? filterCommands(COMMANDS, value.slice(1)) : []
  const theme = getTheme()
  // Border carries mode meaning: slash=primary, idle=silver/dim. While the
  // agent is thinking (steerMode) we drop the frame entirely — just the
  // breathing icon — so there's no long glaring box; the pulse is calm silver,
  // not warning-yellow.
  const borderColor = isSlash ? theme.primary : theme.dim
  const promptColor = isSlash ? theme.primary : steerMode ? theme.secondary : theme.success

  const handleTabComplete = useCallback(() => {
    if (isSlash && filtered.length > 0) {
      const target = filtered[slashIdx] ?? filtered[0]!
      setValue(target.name + ' ')
      setSlashIdx(0)
      return true
    }
    return false
  }, [isSlash, filtered, slashIdx])

  const handleChange = useCallback((v: string) => {
    setValue(v)
    setSlashIdx(0)
  }, [])

  return (
    <>
      {isSlash && filtered.length > 0 && (
        <SlashHint input={value} selectedIdx={Math.min(slashIdx, filtered.length - 1)} commands={COMMANDS} />
      )}
      <Box
        flexDirection="row"
        paddingX={1}
        borderStyle={steerMode ? undefined : 'round'}
        borderColor={borderColor}
        borderDimColor={!isSlash}
      >
        <Text bold color={promptColor}>{steerMode ? PULSE_FRAMES[pulseIdx] : '❯'} </Text>
        <BaseTextInput
          value={value}
          onChange={handleChange}
          vimEnabled={vimEnabled}
          onSubmit={(v) => {
            const trimmed = v.trim()
            if (trimmed) {
              appendHistory(trimmed)
              setHistory(current => nextHistoryAfterSubmit(current, trimmed))
              onSubmit(trimmed)
              setValue('')
              setSlashIdx(0)
            }
          }}
          disabled={disabled}
          placeholder={steerMode ? "Agent is thinking…" : "Type a message... (↑↓ history)"}
          history={history}
          onTabComplete={handleTabComplete}
          isSlashMode={isSlash}
          slashSelectedIdx={slashIdx}
          slashFilteredCount={filtered.length}
          onSlashNavigate={setSlashIdx}
        />
      </Box>
    </>
  )
}
