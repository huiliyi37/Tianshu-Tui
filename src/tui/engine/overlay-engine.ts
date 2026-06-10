/**
 * T9 OverlayEngine — 管理全屏覆盖层的 alternate screen buffer 切换。
 *
 * 核心机制：
 * - 进入 overlay 时：`\x1B[?1049h` 切换到 alternate screen buffer
 * - overlay 内：全屏逐行渲染，用 `cursorTo(1,1)` 定位到顶部
 * - 退出 overlay 时：`\x1B[?1049l` 恢复主屏，scrollback 完整无损
 *
 * Surface 路由逻辑复用现有的 `src/tui/surface/router.ts`（纯逻辑，零依赖）。
 * OverlayEngine 只负责终端 buffer 切换和渲染调度。
 *
 * 支持的 overlay 类型（对应现有 Surface）：
 * - Starmap (星图) — 星君/星域总览
 * - Cockpit (座舱) — 运行时状态仪表盘
 * - Chronicle (编年史) — 会话回放
 * - Pager — 分页查看器
 * - CommandPalette — 命令面板
 */

import type { WriteStream } from 'node:tty'
import { ANSI, cursorTo } from './ansi.js'

export type OverlayId = 'starmap' | 'cockpit' | 'chronicle' | 'pager' | 'command-palette' | string

export interface OverlayRenderer {
  /** 渲染 overlay 内容。返回 ANSI 格式化后的行数组。 */
  render(width: number, height: number): string[]
  /** overlay 激活时的回调 */
  onActivate?(): void
  /** overlay 失活时的回调 */
  onDeactivate?(): void
}

export interface OverlayEngineOptions {
  stdout: WriteStream
  /** 当前终端尺寸获取函数（每次渲染时调用） */
  getSize: () => { cols: number; rows: number }
}

export class OverlayEngine {
  private stdout: WriteStream
  private getSize: () => { cols: number; rows: number }
  private active: OverlayId | null = null
  private renderers = new Map<OverlayId, OverlayRenderer>()
  private inAltScreen = false

  constructor(options: OverlayEngineOptions) {
    this.stdout = options.stdout
    this.getSize = options.getSize
  }

  /**
   * 注册一个 overlay 渲染器。
   * 通常在模块初始化时调用。
   */
  register(id: OverlayId, renderer: OverlayRenderer): void {
    this.renderers.set(id, renderer)
  }

  /** 取消注册 */
  unregister(id: OverlayId): void {
    if (this.active === id) {
      this.deactivate()
    }
    this.renderers.delete(id)
  }

  /**
   * 激活指定 overlay。
   * - 如果已有活跃 overlay，先停用旧的再激活新的。
   * - 自动进入 alternate screen buffer。
   */
  activate(id: OverlayId): boolean {
    const renderer = this.renderers.get(id)
    if (!renderer) return false

    // 停用当前 overlay
    if (this.active !== null) {
      this.deactivateInternal()
    }

    this.active = id
    this.enterAltScreen()
    renderer.onActivate?.()
    this.render()
    return true
  }

  /** 停用当前活跃的 overlay，恢复主屏。 */
  deactivate(): void {
    if (this.active === null) return
    this.deactivateInternal()
  }

  /** 重新渲染当前 overlay（如 resize 后）。 */
  rerender(): void {
    if (this.active === null) return
    this.render()
  }

  /** 当前是否在 overlay 中 */
  isActive(): boolean {
    return this.active !== null
  }

  /** 当前活跃的 overlay ID */
  activeId(): OverlayId | null {
    return this.active
  }

  // ── internal ─────────────────────────────────────────────────

  private enterAltScreen(): void {
    if (this.inAltScreen) return
    this.stdout.write(ANSI.ALT_SCREEN_ON)
    this.stdout.write(ANSI.HIDE_CURSOR)
    this.inAltScreen = true
  }

  private exitAltScreen(): void {
    if (!this.inAltScreen) return
    this.stdout.write(ANSI.SHOW_CURSOR)
    this.stdout.write(ANSI.ALT_SCREEN_OFF)
    this.inAltScreen = false
  }

  private deactivateInternal(): void {
    const id = this.active!
    const renderer = this.renderers.get(id)
    renderer?.onDeactivate?.()
    this.active = null
    this.exitAltScreen()
  }

  private render(): void {
    const renderer = this.renderers.get(this.active!)
    if (!renderer) return

    const { cols, rows } = this.getSize()
    const lines = renderer.render(cols, rows)

    // 全屏逐行渲染：从 (1,1) 开始，逐行擦除+写入
    let out = cursorTo(1, 1)
    for (let i = 0; i < rows; i++) {
      out += ANSI.ERASE_LINE
      if (i < lines.length && lines[i] !== undefined) {
        out += lines[i]
      }
      if (i < rows - 1) out += '\n'
    }
    this.stdout.write(out)
  }
}
