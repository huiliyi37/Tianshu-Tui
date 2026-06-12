/**
 * T9 ResizeHandler — 终端 resize 事件的防抖处理。
 *
 * trailing-edge debounce（默认 150ms）合并连发的 resize 事件，settle 后回调一次。
 *
 * **scrollback 不受影响的前提**：resize 时只重绘 live region；但终端会把已绘的
 * live 内容按新宽度 reflow，其占用行数随之变化。LiveEngine.render()/clear() 内的
 * reconcileWidth() 检测到宽度变化时按新宽从 lineCache 重算行数再相对回顶，
 * 否则旧帧顶部会残留进 scrollback（多份不同宽度的 chrome/面板叠屏）。
 * 这条 reflow 协调是 resize 正确性的关键 —— 改 LiveEngine 回顶逻辑时务必保留。
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
