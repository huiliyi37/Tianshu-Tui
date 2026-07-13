export interface OutputStreamScheduler {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface OutputStreamBudgetOptions {
  emit: (text: string) => void
  maxVisible: number
  budgetUnit?: 'bytes' | 'characters'
  coalesceMs?: number
  coalesceBytes?: number
  truncationMarker?: string
  scheduler?: OutputStreamScheduler
}

const defaultScheduler: OutputStreamScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function takeCodePoints(text: string, limit: number, unit: 'bytes' | 'characters'): {
  text: string
  consumed: number
  complete: boolean
} {
  if (limit <= 0) return { text: '', consumed: 0, complete: text.length === 0 }
  let consumed = 0
  let end = 0
  for (const point of text) {
    // Legacy run_tests counted String.length (UTF-16 units). Keep that budget
    // while iterating whole code points so an astral character is never split.
    const size = unit === 'bytes' ? Buffer.byteLength(point) : point.length
    if (consumed + size > limit) break
    consumed += size
    end += point.length
  }
  return { text: text.slice(0, end), consumed, complete: end === text.length }
}

/**
 * Bounds and coalesces real-time UI callbacks. It does not transform raw tool
 * output or model-facing results.
 */
export class OutputStreamBudget {
  private readonly emitFn: (text: string) => void
  private readonly maxVisible: number
  private readonly budgetUnit: 'bytes' | 'characters'
  private readonly coalesceMs: number
  private readonly coalesceBytes: number
  private readonly truncationMarker: string
  private readonly scheduler: OutputStreamScheduler
  private visible = 0
  private buffered = ''
  private timer: unknown
  private emittedFirst = false
  private truncated = false
  private disposed = false

  constructor(options: OutputStreamBudgetOptions) {
    this.emitFn = options.emit
    this.maxVisible = Math.max(0, options.maxVisible)
    this.budgetUnit = options.budgetUnit ?? 'bytes'
    this.coalesceMs = options.coalesceMs ?? 40
    // coalesceBytes is always measured in UTF-8 bytes, even when budgetUnit is 'characters'.
    this.coalesceBytes = options.coalesceBytes ?? 2 * 1024
    this.truncationMarker = options.truncationMarker ?? '\n[stream output truncated]\n'
    this.scheduler = options.scheduler ?? defaultScheduler
  }

  push(text: string): void {
    if (this.disposed || this.truncated || text.length === 0) return
    const remaining = this.maxVisible - this.visible
    const accepted = takeCodePoints(text, remaining, this.budgetUnit)
    this.visible += accepted.consumed

    if (accepted.text) {
      if (!this.emittedFirst) {
        this.emittedFirst = true
        this.emitFn(accepted.text)
      } else {
        this.buffered += accepted.text
        if (Buffer.byteLength(this.buffered) >= this.coalesceBytes) this.flush()
        else this.schedule()
      }
    }

    if (!accepted.complete) {
      this.flush()
      this.truncated = true
      this.emitFn(this.truncationMarker)
    }
  }

  flush(): void {
    if (this.disposed) return
    this.cancelTimer()
    if (!this.buffered) return
    const text = this.buffered
    this.buffered = ''
    this.emitFn(text)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelTimer()
    this.buffered = ''
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.coalesceMs)
    const timer = this.timer as { unref?: () => void }
    timer?.unref?.()
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    this.scheduler.clearTimeout(this.timer)
    this.timer = undefined
  }
}
