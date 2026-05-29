import { Component, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from './theme.js'

interface Props {
  children: ReactNode
  /** Increment to force remount children after error recovery */
  resetKey?: number
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color="red">Runtime error: {this.state.error.message}</Text>
          <Text color={getTheme().muted}>Session is preserved. Press Ctrl+C to restart.</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
