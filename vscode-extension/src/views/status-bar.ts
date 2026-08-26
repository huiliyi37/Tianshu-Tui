/**
 * 状态栏会话状态 — sidecar 生命周期 + 活跃会话运行态。
 * 事件驱动（launcher 状态回调 + 会话 status 事件），不轮询。
 */
import * as vscode from 'vscode'

export type SidecarUiState = 'starting' | 'ready' | 'dead'

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private sidecarState: SidecarUiState | 'off' = 'off'
  private sessionRunning = false
  private pendingApprovals = 0

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.command = 'tianshu.openInEditor'
    this.render()
    this.item.show()
  }

  setSidecarState(state: SidecarUiState, detail?: string): void {
    this.sidecarState = state
    if (state !== 'ready') this.sessionRunning = false
    this.item.tooltip = detail ? `天枢 — ${detail}` : '天枢 — 点击打开座舱'
    this.render()
  }

  /** 会话 status 事件（running/idle 等）驱动运行指示。 */
  setSessionStatus(status: string): void {
    this.sessionRunning = status === 'running'
    this.render()
  }

  setPendingApprovals(count: number): void {
    this.pendingApprovals = count
    this.render()
  }

  private render(): void {
    if (this.pendingApprovals > 0) {
      this.item.text = `$(bell-dot) 天枢 ${this.pendingApprovals}`
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      return
    }
    this.item.backgroundColor = undefined
    switch (this.sidecarState) {
      case 'off':
        this.item.text = '$(circle-outline) 天枢'
        break
      case 'starting':
        this.item.text = '$(loading~spin) 天枢'
        break
      case 'ready':
        this.item.text = this.sessionRunning ? '$(sync~spin) 天枢' : '$(check) 天枢'
        break
      case 'dead':
        this.item.text = '$(error) 天枢'
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        break
    }
  }

  dispose(): void {
    this.item.dispose()
  }
}
