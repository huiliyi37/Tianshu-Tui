import { Box, Text } from 'ink'

export function onboardingText(): string {
  return [
    'Welcome to Rivet',
    'Configure a provider key with: rivet config set-key <provider> <api-key>',
    'Try /help for commands, /model list for models, and /mcp for server status.',
    'Run /onboarding dismiss when you are ready to hide this guide.',
  ].join('\n')
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
