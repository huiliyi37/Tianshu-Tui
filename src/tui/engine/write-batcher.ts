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
 *
 * 健壮性：onFlush 在 microtask 中执行，若直接抛出会变成 unhandled rejection
 * 崩进程。故 flush 用 try/catch 包裹，错误交给 onError（默认记录到 stderr
 * 但不中断 TUI），保证一次渲染异常不会让整个终端崩溃。
 */

export class WriteBatcher {
  private pending = false
  private onFlush: () => void
  private onError: (err: unknown) => void

  constructor(onFlush: () => void, onError?: (err: unknown) => void) {
    this.onFlush = onFlush
    // 默认错误处理：写 stderr 但不 throw，避免渲染抖动杀死 TUI 进程。
    // 调用方可注入自己的 handler（如转发到诊断日志）覆盖此行为。
    this.onError = onError ?? ((err) => {
      try {
        process.stderr.write(`WriteBatcher flush error: ${String(err)}\n`)
      } catch {
        // stderr 不可写时彻底静默，绝不 throw
      }
    })
  }

  /** 请求在下一次 microtask 刷新 */
  schedule(): void {
    if (this.pending) return
    this.pending = true
    void Promise.resolve().then(() => {
      this.pending = false
      try {
        this.onFlush()
      } catch (err) {
        this.onError(err)
      }
    })
  }
}
