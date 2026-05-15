import { useState, useMemo } from 'react'
import { Box, Text } from 'ink'
import { BaseTextInput } from './base-text-input.js'
import { loadHistory, appendHistory } from './history.js'

interface InputBarProps {
  onSubmit: (value: string) => void
  disabled?: boolean
}

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [value, setValue] = useState('')
  const history = useMemo(() => loadHistory(), [])

  return (
    <Box flexDirection="row" paddingX={1} paddingY={0}>
      <Text bold color="green">❯ </Text>
      <BaseTextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          if (v.trim()) {
            appendHistory(v.trim())
            onSubmit(v.trim())
            setValue('')
          }
        }}
        disabled={disabled}
        placeholder="Type a message... (↑↓ history)"
        history={history}
      />
    </Box>
  )
}
