// Terminal panel — UI placeholder only. No PTY/shell implementation.
// Reserves the layout slot and keyboard shortcut (Cmd+J) for future
// terminal integration. When TerminalShell is implemented, it plugs
// into this component via the reserved interface below.

export interface TerminalShell {
  spawn(cwd: string): void
  resize(cols: number, rows: number): void
  write(data: string): void
  onData: ((data: string) => void) | null
  dispose(): void
}

export function TerminalPanel(props: { cwd: string }) {
  return (
    <div className="terminal-panel">
      <div className="terminal-placeholder">
        <span className="terminal-glyph" aria-hidden>▸</span>
        <span className="terminal-path">{props.cwd}</span>
        <span className="terminal-hint">终端就绪 · Cmd+J 切换</span>
      </div>
      <div className="terminal-output" aria-disabled="true">
        {/* Shell output area — reserved for TerminalShell integration */}
      </div>
    </div>
  )
}
