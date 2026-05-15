import { Box, Text } from 'ink'

interface StatusBarProps {
  model: string
  cacheHitRate: number
  totalCost: string
  currentTokens: number
  maxTokens: number
}

function tokenBar(current: number, max: number, width = 10): string {
  const filled = Math.min(Math.round((current / max) * width), width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function StatusBar({ model, cacheHitRate, totalCost, currentTokens, maxTokens }: StatusBarProps) {
  const hitPct = (cacheHitRate * 100).toFixed(1)
  const usagePct = ((currentTokens / maxTokens) * 100).toFixed(0)
  const bar = tokenBar(currentTokens, maxTokens)
  const color = currentTokens / maxTokens > 0.8 ? 'red' : currentTokens / maxTokens > 0.5 ? 'yellow' : 'green'

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="single" borderColor="gray">
      <Box gap={1}>
        <Text bold color="cyan">{model}</Text>
        <Text dimColor>
          cache:{hitPct}% | ¥{totalCost}
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={color}>{bar}</Text>
        <Text dimColor>
          {currentTokens.toLocaleString()}/{maxTokens.toLocaleString()} ({usagePct}%)
        </Text>
      </Box>
    </Box>
  )
}
