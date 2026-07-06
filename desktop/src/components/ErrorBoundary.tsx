import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from '../i18n'

interface Props {
  /** Shown in the fallback header so root vs. surface failures are distinguishable. */
  label?: string
  children: ReactNode
  /** Optional custom fallback renderer; receives the error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * React error boundary. A throw in a reducer-driven render (e.g. a malformed
 * event folded into a block, or a surface component bug) would otherwise blank
 * the whole Tauri webview to a white screen with no recovery. This catches the
 * throw, shows an inline fallback, and offers a reset so the user can retry the
 * subtree without restarting the app. Wrap the root (last-resort) and volatile
 * surfaces (so one surface's crash doesn't take down the rail/navigation).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset)
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-title">
            {this.props.label ? i18n.t('error:boundary', { label: this.props.label }) : i18n.t('error:boundaryGeneric')}
          </div>
          <div className="error-boundary-message">{error.message || String(error)}</div>
          <button type="button" className="error-boundary-retry" onClick={this.reset}>
            {i18n.t('error:retry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
