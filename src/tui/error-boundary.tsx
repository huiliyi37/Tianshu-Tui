import { Component, type ReactNode } from 'react'
import { Box, Text } from 'ink'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color="red">Runtime error: {this.state.error.message}</Text>
          <Text dimColor>Session is preserved. Restart to continue.</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
