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

// ASCII art — 7 lines tall, fits 80-col terminals
const LOGO = [
  '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
  '┃                                    ┃',
  '┃     ⬡  R I V E T                  ┃',
  '┃                                    ┃',
  '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
]

const STAGGER_MS = 150

export function WelcomeScreen({ model, cwd }: WelcomeScreenProps) {
  const theme = getTheme()
  const { rows } = useTerminalSize()
  const dir = cwd.replace(/^.*\//, '')
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    const timers = [1, 2, 3].map(i => setTimeout(() => setPhase(i), STAGGER_MS * i))
    return () => timers.forEach(clearTimeout)
  }, [])

  // Vertical padding to center content in terminal
  // Logo(5) + gap(1) + meta(1) + gap(2) + shortcuts(4) + gap(1) + hint(1) = ~15 lines
  const contentHeight = 15
  const topPad = Math.max(1, Math.floor((rows - contentHeight) / 2) - 2)

  return (
    <Box flexDirection="column" paddingTop={topPad} alignItems="center">
      {/* Phase 0: Logo box */}
      <Box flexDirection="column" alignItems="center">
        {LOGO.map((line, i) => (
          <Text key={i} color={theme.primary} bold>{line}</Text>
        ))}
      </Box>

      {/* Phase 1: Model + directory */}
      {phase >= 1 && (
        <Box marginTop={1} justifyContent="center">
          <Text color={theme.secondary}>{model}</Text>
          <Text color={theme.dim}> · </Text>
          <Text color={theme.dim}>{dir}/</Text>
        </Box>
      )}

      {/* Phase 2: Shortcuts */}
      {phase >= 2 && (
        <Box flexDirection="column" marginTop={2} alignItems="center">
          <Text>
            <Text color={theme.muted}>Ctrl+C </Text>
            <Text color={theme.dim}>interrupt</Text>
            <Text color={theme.dim}>    </Text>
            <Text color={theme.muted}>Ctrl+K </Text>
            <Text color={theme.dim}>palette</Text>
          </Text>
          <Text>
            <Text color={theme.muted}>/help  </Text>
            <Text color={theme.dim}>commands</Text>
            <Text color={theme.dim}>    </Text>
            <Text color={theme.muted}>Alt+Ent</Text>
            <Text color={theme.dim}> multi-line</Text>
          </Text>
        </Box>
      )}

      {/* Phase 3: Ready hint */}
      {phase >= 3 && (
        <Box marginTop={2}>
          <Text color={theme.dim}>Type a message to begin ↵</Text>
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
