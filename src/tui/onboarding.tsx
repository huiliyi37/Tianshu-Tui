import { Box, Text } from 'ink'
import { useState, useEffect } from 'react'
import { getTheme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'

export function onboardingText(): string {
  return [
    'Welcome to Rivet',
    'Configure a provider with: rivet config',
    'Scripted setup: rivet config setup deepseek --key-env DEEPSEEK_API_KEY',
    'Try /help for commands, /model list for models, and /mcp for server status.',
    'Run /onboarding dismiss when you are ready to hide this guide.',
  ].join('\n')
}

interface WelcomeScreenProps {
  model: string
  cwd: string
}

const STAGGER_MS = 120

export function WelcomeScreen({ model, cwd }: WelcomeScreenProps) {
  const theme = getTheme()
  const { rows } = useTerminalSize()
  const dir = cwd.replace(/^.*\//, '')
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    const timers = [1, 2].map(i => setTimeout(() => setPhase(i), STAGGER_MS * i))
    return () => timers.forEach(clearTimeout)
  }, [])

  const contentHeight = 10
  const topPad = Math.max(1, Math.floor((rows - contentHeight) / 2) - 2)

  return (
    <Box flexDirection="column" paddingTop={topPad} alignItems="center">
      <Text bold color={theme.primary}>Tianshu</Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>{model}</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.dim}>{dir}/</Text>
      </Box>

      {phase >= 1 && (
        <Box flexDirection="column" marginTop={2} alignItems="center">
          <Text>
            <Text color={theme.dim}>Ctrl+C </Text>
            <Text color={theme.dim}>interrupt    </Text>
            <Text color={theme.dim}>Ctrl+K </Text>
            <Text color={theme.dim}>palette</Text>
          </Text>
          <Text>
            <Text color={theme.dim}>/help  </Text>
            <Text color={theme.dim}>commands    </Text>
            <Text color={theme.dim}>Alt+Enter </Text>
            <Text color={theme.dim}>multi-line</Text>
          </Text>
        </Box>
      )}

      {phase >= 2 && (
        <Box marginTop={2}>
          <Text color={theme.dim}>Type a message to begin</Text>
        </Box>
      )}
    </Box>
  )
}

export function OnboardingPanel() {
  const theme = getTheme()
  return (
    <Box paddingX={2} marginBottom={1} flexDirection="column">
      <Text color={theme.primary} bold>Welcome to Rivet</Text>
      <Text color={theme.secondary}>Configure a provider with: <Text bold>rivet config</Text></Text>
      <Text color={theme.secondary}>Scripted setup: <Text bold>rivet config setup deepseek --key-env DEEPSEEK_API_KEY</Text></Text>
      <Text color={theme.secondary}>Try <Text bold>/help</Text> for commands, <Text bold>/model list</Text> for models, and <Text bold>/mcp</Text> for server status.</Text>
      <Text color={theme.dim}>Run <Text bold>/onboarding dismiss</Text> to hide this guide.</Text>
    </Box>
  )
}
