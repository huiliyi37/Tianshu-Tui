import { Box, Text } from 'ink'

interface StatusBarProps {
  model: string
  cacheHitRate: number
  totalCost: string
  currentTokens: number
  maxTokens: number
}

export function StatusBar({ model, cacheHitRate, totalCost, currentTokens, maxTokens }: StatusBarProps) {
  const hitPct = (cacheHitRate * 100).toFixed(1)
  const usagePct = ((currentTokens / maxTokens) * 100).toFixed(0)

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="single" borderColor="gray">
      <Box gap={1}>
        <Text bold color="cyan">{model}</Text>
        <Text dimColor>
          cache:{hitPct}% | ¥{totalCost}
        </Text>
      </Box>
      <Box gap={1}>
        <Text dimColor>
          {currentTokens.toLocaleString()}/{maxTokens.toLocaleString()} tokens ({usagePct}%)
        </Text>
      </Box>
    </Box>
  )
}
