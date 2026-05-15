import { Box, Text } from 'ink'

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
}

export function ToolCard({ name, result, isError }: ToolCardProps) {
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      marginY={1}
      borderStyle="single"
      borderColor={isError ? 'red' : 'gray'}
    >
      <Text bold color={isError ? 'red' : 'cyan'}>
        ── {name} ──
      </Text>
      <Text>{result}</Text>
    </Box>
  )
}
