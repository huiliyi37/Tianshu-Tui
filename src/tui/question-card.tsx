import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface QuestionCardProps {
  question: string
}

/**
 * QuestionCard — renders the model's question to the user with visual prominence.
 *
 * Unlike regular ToolCard (which shows `? ask` glyph + content),
 * QuestionCard uses a bordered box with a prompt indicator so the user
 * clearly sees the question and knows to type their answer.
 */
export const QuestionCard = memo(function QuestionCard({ question }: QuestionCardProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
      >
        <Text bold color={theme.primary}>{question}</Text>
        <Text color={theme.muted}>⏳ Type your response below</Text>
      </Box>
    </Box>
  )
})
