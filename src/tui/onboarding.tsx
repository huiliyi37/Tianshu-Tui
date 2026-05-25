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
      <Box marginBottom={1}>
        <Text color={theme.primary} bold>rivet</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.secondary}>{model}</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.dim}>{dir}/</Text>
      </Box>
      <Box flexDirection="column">
        <Text color={theme.dim}>  Ctrl+C  </Text><Text color={theme.secondary}>clear / interrupt</Text>
        <Text color={theme.dim}>  Ctrl+K  </Text><Text color={theme.secondary}>command palette</Text>
        <Text color={theme.dim}>  /help   </Text><Text color={theme.secondary}>all commands</Text>
        <Text color={theme.dim}>  Alt+Ent </Text><Text color={theme.secondary}>multi-line</Text>
      </Box>
    </Box>
  )
}

export function OnboardingPanel() {
  const theme = getTheme()
  return (
    <Box paddingX={2} marginBottom={1} flexDirection="column">
      <Text color={theme.primary} bold>Welcome to Rivet</Text>
      <Text color={theme.secondary}>Configure a provider key with: <Text bold>rivet config set-key &lt;provider&gt; &lt;api-key&gt;</Text></Text>
      <Text color={theme.secondary}>Try <Text bold>/help</Text> for commands, <Text bold>/model list</Text> for models, and <Text bold>/mcp</Text> for server status.</Text>
      <Text color={theme.dim}>Run <Text bold>/onboarding dismiss</Text> to hide this guide.</Text>
    </Box>
  )
}
