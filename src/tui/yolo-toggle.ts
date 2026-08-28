/**
 * /yolo 与 /yes 覆盖版共享语义（R25 提取——R24 的两份复制是分叉根因：
 * R23 首版丢 off 分支即复制失同步的实例）。无参/on → 全自动（跳过权限确认、
 * 无限轮次、持久化默认）；off → 回自动（200 轮预算）。显式输入命令即视为确认；
 * YOLO 确认面板打开时视为确认并关闭；planning 叠层期间同步
 * approvalModeBeforePlan（Shift+Tab 退出恢复用户最新意图）。
 * 持久化失败不静默——「已设为默认」的承诺要落盘才成立，失败必须可见。
 */
export interface YoloToggleTexts {
  /** 开启提示（应含关闭入口，如「关闭: /yolo off」） */
  on: string
  /** 关闭提示 */
  off: string
}

export interface YoloToggleEnv {
  agent: {
    setApprovalMode(mode: string): void
    config: { maxTurns: number }
    planModeState: string | null | undefined
  }
  app: {
    setApprovalMode(mode: string): void
    approvalModeBeforePlan: string | null
    choicePanelKind: string
    activeOverlayId(): string | null
    deactivateOverlay(): void
    commitStatic(text: string): void
    setStreamingState(v: boolean): void
  }
  /** 持久化审批默认值（注入以便测试断言与失败注入） */
  persistDefault(mode: string): void
}

export function handleYoloToggle(trimmed: string, env: YoloToggleEnv, texts: YoloToggleTexts): boolean {
  const arg = trimmed.split(/\s+/)[1]?.toLowerCase()
  const applyLive = (mode: 'dangerously-skip-permissions' | 'auto-safe') => {
    env.agent.setApprovalMode(mode)
    env.agent.config.maxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
    env.app.setApprovalMode(mode)
    // Plan 叠层期间改审批 → 同步 stash，Shift+Tab 退出时恢复用户最新意图
    if (env.agent.planModeState === 'planning') {
      env.app.approvalModeBeforePlan = mode
    }
    try {
      env.persistDefault(mode)
    } catch (err) {
      env.app.commitStatic(`⚠ 已切换但持久化失败: ${(err as Error).message} — 重启后不保持`)
    }
  }
  // YOLO 确认面板打开时，命令视为确认并关掉面板
  if (env.app.choicePanelKind === 'permission-yolo-confirm' && env.app.activeOverlayId() === 'choice-panel') {
    env.app.choicePanelKind = 'effort'
    env.app.deactivateOverlay()
  }
  if (arg === 'off') {
    applyLive('auto-safe')
    env.app.commitStatic(texts.off)
    env.app.setStreamingState(false)
    return true
  }
  applyLive('dangerously-skip-permissions')
  env.app.commitStatic(texts.on)
  env.app.setStreamingState(false)
  return true
}
