/**
 * T9 ResizeHandler — 终端 resize 事件的防抖处理。
 *
 * 当前 Ink TUI 的方案已在 `use-terminal-size.ts` 中实现了
 * trailing-edge debounce + `inkInstance.clear()` workaround。
 * T9 中不再需要 clear workaround——resize 时只重绘 live region，
 * scrollback 完全不受影响。
 */

import type { WriteStream } from 'node:tty'

export interface ResizeHandlerOptions {
  stdout: WriteStream
  /** 防抖延迟（毫秒），默认 150ms */
  debounceMs?: number
}

export type ResizeCallback = (cols: number, rows: number) => void

export class ResizeHandler {
  private stdout: WriteStream
  private debounceMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private callback: ResizeCallback | null = null
  private currentCols: number
  private currentRows: number

  constructor(options: ResizeHandlerOptions) {
    this.stdout = options.stdout
    this.debounceMs = options.debounceMs ?? 150
    this.currentCols = this.stdout.columns
    this.currentRows = this.stdout.rows
  }

  /**
   * 注册 resize 回调。每个 ResizeHandler 只有一个回调。
   * 多次调用会替换之前的回调。
   */
  onResize(callback: ResizeCallback): void {
    this.callback = callback
    this.stdout.on('resize', this.handleResize)
  }

  /** 获取当前终端尺寸 */
  getSize(): { cols: number; rows: number } {
    return { cols: this.stdout.columns, rows: this.stdout.rows }
  }

  /** 移除 resize 监听 */
  dispose(): void {
    this.stdout.removeListener('resize', this.handleResize)
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.callback = null
  }

  // ── internal ─────────────────────────────────────────────────

  private handleResize = (): void => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const cols = this.stdout.columns
      const rows = this.stdout.rows
      if (cols !== this.currentCols || rows !== this.currentRows) {
        this.currentCols = cols
        this.currentRows = rows
        this.callback?.(cols, rows)
      }
    }, this.debounceMs)
  }
}
