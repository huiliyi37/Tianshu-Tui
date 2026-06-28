// 集成终端 — xterm.js 前端 + Rust portable-pty 后端，经 Tauri IPC 双向桥接。
//
// 生命周期：组件挂载 → 开 xterm → fit 出 cols/rows → 先注册输出/退出监听
// → pty_spawn（id 前端生成，杜绝首屏竞态）→ onData 写入、ResizeObserver 同步尺寸
// → 卸载时 pty_kill + 解除监听 + dispose。

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { UnlistenFn } from '@tauri-apps/api/event'
import '@xterm/xterm/css/xterm.css'
import {
  isTauri,
  onPtyExit,
  onPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from '../lib/pty'

const MONO_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

/** 从 tokens.css 的 CSS 变量取实际色值，让终端配色跟随应用明暗主题。 */
function readThemeColors(): { background: string; foreground: string; cursor: string } {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    background: v('--panel', '#151519'),
    foreground: v('--text', '#e7e7ec'),
    cursor: v('--accent', '#5aa9ff'),
  }
}

export function TerminalPanel({ cwd, ptyId: externalPtyId }: { cwd: string; ptyId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // Stable fallback id for the no-prop case. A bare `crypto.randomUUID()` in the
  // render body would mint a new id every render, so once `ptyId` is in the
  // effect deps the terminal would tear down + respawn on every re-render.
  const fallbackIdRef = useRef('')
  if (!fallbackIdRef.current) fallbackIdRef.current = crypto.randomUUID()
  const ptyId = externalPtyId ?? fallbackIdRef.current

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // 无 Tauri runtime（纯浏览器 dev）→ 不挂 xterm，由 JSX 渲染降级提示。
    if (!isTauri()) return

    let disposed = false
    let unlistenOutput: UnlistenFn | null = null
    let unlistenExit: UnlistenFn | null = null

    const colors = readThemeColors()
    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const safeFit = () => {
      try {
        fit.fit()
      } catch {
        /* 容器尚未布局完成，下一次 ResizeObserver 会补上 */
      }
    }
    safeFit()

    const onData = term.onData((data) => {
      if (!disposed) void ptyWrite(ptyId, data).catch(() => {})
    })

    const ro = new ResizeObserver(() => {
      safeFit()
      if (!disposed) void ptyResize(ptyId, term.cols, term.rows).catch(() => {})
    })
    ro.observe(host)

    ;(async () => {
      // 先注册监听再 spawn：用前端生成的 id 过滤共享通道，shell 首屏 prompt 不丢。
      unlistenOutput = await onPtyOutput(ptyId, (bytes) => term.write(bytes))
      unlistenExit = await onPtyExit(ptyId, () => {
        term.write('\r\n\x1b[90m[shell 已退出 · 关闭并重开终端以重启]\x1b[0m\r\n')
      })
      if (disposed) {
        unlistenOutput?.()
        unlistenExit?.()
        return
      }
      try {
        await ptySpawn({ id: ptyId, cwd: cwdRef.current || '', cols: term.cols, rows: term.rows })
        term.focus()
      } catch (err) {
        term.write(`\r\n\x1b[91m[终端启动失败] ${String(err)}\x1b[0m\r\n`)
      }
    })()

    return () => {
      disposed = true
      ro.disconnect()
      onData.dispose()
      unlistenOutput?.()
      unlistenExit?.()
      void ptyKill(ptyId).catch(() => {})
      term.dispose()
    }
    // ptyId 变更时重建：cleanup 杀掉旧 pty + dispose 旧 term，再以新 id 重新挂载，
    // 不再静默忽略切换。cwd 经 cwdRef 读取，故切项目不重启已开终端（符合终端常规语义）。
  }, [ptyId])

  return (
    <div className="terminal-panel">
      <div className="terminal-bar">
        <span className="terminal-glyph" aria-hidden>▸</span>
        <span className="terminal-path">{cwd || '~'}</span>
        <span className="terminal-hint">Cmd+J 切换</span>
      </div>
      <div className="terminal-host" ref={hostRef}>
        {!isTauri() && (
          <div className="terminal-fallback">终端需在桌面应用内运行（Tauri runtime 不可用）。</div>
        )}
      </div>
    </div>
  )
}
