/**
 * WatchdogRecoveryPolicy — watchdog stall 自动恢复的共享状态机（TUI 与桌面 sidecar 共用）。
 *
 * 三件套语义（与 TuiApp v3 实现对齐，设计溯源见
 * docs/superpowers/plans/2026-07-02-watchdog-session-total-stall-gap.md）：
 * - consecutive cap（默认 3）：连续自动续跑无 turn 完成即停。turn 完成 / 用户提交时归零。
 * - session-total cap（默认 12）：永不重置的会话级配额。只有**密集** stall（自上次续跑
 *   以来进度单元 < 阈值）才消耗；稀疏 stall（>= 2 个完整工具批的真实工作）免费。
 * - 进度单元 = turn 完成次数 + 终态工具结果次数。调用方负责过滤流式 chunk：
 *   isError === undefined 的中间更新不得调用 recordToolResult（否则单次长输出工具
 *   就能凑满阈值，把密集 stall 伪装成稀疏——TUI 侧已修过这个 bug）。
 *
 * 纯状态机：无 UI、无计时器、无 I/O。抑制条件（审批挂起、输入草稿、拒绝 grace 窗口）
 * 由调用方判定后经 onStall({ suppressed }) 传入——两端抑制来源不同（TUI 看输入框与
 * 本地审批态，桌面看 HTTP 审批 pending map），但抑制后的语义相同：不续跑、不消耗状态。
 */
export interface StallDecision {
  autoContinue: boolean
  /** autoContinue=false 时的停止原因。 */
  stopReason?: 'suppressed' | 'consecutive' | 'session-total'
  /** autoContinue=true 时标记本次是否消耗了 session 配额（密集 stall）。 */
  dense?: boolean
}

export class WatchdogRecoveryPolicy {
  private consecutiveCount = 0
  private sessionTotalCount = 0
  private progressUnits = 0
  private readonly maxConsecutive: number
  private readonly maxSessionTotal: number
  private readonly progressThreshold: number

  constructor(opts?: { maxConsecutive?: number; maxSessionTotal?: number; progressThreshold?: number }) {
    this.maxConsecutive = opts?.maxConsecutive ?? 3
    this.maxSessionTotal = opts?.maxSessionTotal ?? 12
    this.progressThreshold = opts?.progressThreshold ?? 4
  }

  /** turn 完成（含中间 isFinal:false）：真实前进——重置 consecutive 并 +1 进度。 */
  recordTurnComplete(): void {
    this.consecutiveCount = 0
    this.progressUnits++
  }

  /** 终态工具结果 +1 进度。流式 chunk（isError === undefined）不得调用。 */
  recordToolResult(): void {
    this.progressUnits++
  }

  /** 用户主动提交：恢复完整续跑预算。进度不清（submit 前后合计仍是真实工作）。 */
  recordUserSubmit(): void {
    this.consecutiveCount = 0
  }

  /**
   * watchdog 家族 stall 的决策入口。suppressed=true 时不消耗任何状态直接拒绝；
   * cap 越界时同样不消耗（进度保留到下一次判定）；只有真正续跑的 stall 才
   * consecutive+1、按密集判定计配额、清零进度。
   */
  onStall(opts?: { suppressed?: boolean }): StallDecision {
    if (opts?.suppressed) return { autoContinue: false, stopReason: 'suppressed' }
    const sessionTotalExhausted = this.sessionTotalCount >= this.maxSessionTotal
    if (sessionTotalExhausted || this.consecutiveCount >= this.maxConsecutive) {
      return { autoContinue: false, stopReason: sessionTotalExhausted ? 'session-total' : 'consecutive' }
    }
    this.consecutiveCount++
    const dense = this.progressUnits < this.progressThreshold
    if (dense) this.sessionTotalCount++
    this.progressUnits = 0
    return { autoContinue: true, dense }
  }

  /** 遥测快照（watchdog_recovery 事件负载 / 调试用）。 */
  snapshot(): { consecutive: number; sessionTotal: number; progressUnits: number } {
    return {
      consecutive: this.consecutiveCount,
      sessionTotal: this.sessionTotalCount,
      progressUnits: this.progressUnits,
    }
  }
}
