import { Box, Text } from 'ink'
import { getTheme } from './theme.js'

export function onboardingText(): string {
  return [
    'Welcome to Rivet',
    'Configure a provider key with: rivet config set-key <provider> <api-key>',
    'Try /help for commands, /model list for models, and /mcp for server status.',
    'Run /onboarding dismiss when you are ready to hide this guide.',
  ].join('\n')
}

interface WelcomeScreenProps {
  model: string
  cwd: string
}

export function WelcomeScreen({ model, cwd }: WelcomeScreenProps) {
  const theme = getTheme()
  const dir = cwd.replace(/^.*\//, '')

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.primary} bold>
          {'  ╭─────────────────────────╮'}
        </Text>
        <Text color={theme.primary} bold>
          {'  │    ◆  R I V E T  ◆     │'}
        </Text>
        <Text color={theme.primary} bold>
          {'  ╰─────────────────────────╯'}
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text>  Model: <Text bold color={theme.secondary}>{model}</Text></Text>
        <Text>  Dir:   <Text dimColor>{dir}/</Text></Text>
      </Box>
      <Box flexDirection="column" paddingX={2}>
        <Text dimColor>{'─'.repeat(36)}</Text>
        <Text dimColor>  Ctrl+C  clear input / interrupt</Text>
        <Text dimColor>  ↑ ↓     history navigation</Text>
        <Text dimColor>  /help   commands list</Text>
        <Text dimColor>  /model  switch model</Text>
        <Text dimColor>  Alt+Ent multi-line input</Text>
        <Text dimColor>{'─'.repeat(36)}</Text>
      </Box>
    </Box>
  )
}

export function OnboardingPanel() {
  return (
    <Box paddingX={2} marginBottom={1} borderStyle="single" borderColor="cyan" flexDirection="column">
      <Text bold color="cyan">Welcome to Rivet</Text>
      <Text>Configure a provider key with: <Text bold>rivet config set-key &lt;provider&gt; &lt;api-key&gt;</Text></Text>
      <Text>Try <Text bold>/help</Text> for commands, <Text bold>/model list</Text> for models, and <Text bold>/mcp</Text> for server status.</Text>
      <Text>Run <Text bold>/onboarding dismiss</Text> when you are ready to hide this guide.</Text>
    </Box>
  )
}
