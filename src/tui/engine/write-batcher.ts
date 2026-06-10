/**
 * T9 WriteBatcher — 微任务级别批处理合并器。
 *
 * 替代 Ink 的 RenderBatcher（依赖 React 调度），直接将多次 render 调用
 * 合并为一次 LiveEngine.render()。
 *
 * 策略：在同一个微任务 tick 内的多次 flush 调用只执行最后一次。
 * 利用 Promise.resolve().then() 的 microtask 队列合并。
 *
 * BlockStreamWriter.onBlock → WriteBatcher.flush() → LiveEngine.render()
 */

export class WriteBatcher {
  private pending = false
  private onFlush: () => void

  constructor(onFlush: () => void) {
    this.onFlush = onFlush
  }

  /** 请求在下一次 microtask 刷新 */
  schedule(): void {
    if (this.pending) return
    this.pending = true
    void Promise.resolve().then(() => {
      this.pending = false
      this.onFlush()
    })
  }
}
