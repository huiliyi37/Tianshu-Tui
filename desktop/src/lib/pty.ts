// PTY 桥接 — 通过 Tauri IPC 与 Rust 侧 portable-pty 会话通信。
//
// 注意：PTY 走 Tauri IPC（src-tauri/src/pty.rs），不走 sidecar HTTP。
// 在纯浏览器 dev 模式（无 Tauri）下 invoke/listen 会抛错，调用方需自行降级。

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface PtyOutputEvent {
  id: string
  /** base64(原始字节)。 */
  data: string
}

export interface PtyExitEvent {
  id: string
}

/** Tauri runtime 是否可用（注入了 __TAURI_INTERNALS__）。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** base64 → 字节，交给 xterm 的流式 UTF-8 解码器拼接多字节边界。 */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function ptySpawn(opts: {
  id: string
  cwd: string
  cols: number
  rows: number
  shell?: string
}): Promise<void> {
  return invoke('pty_spawn', opts)
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke('pty_write', { id, data })
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { id, cols, rows })
}

export function ptyKill(id: string): Promise<void> {
  return invoke('pty_kill', { id })
}

/** 订阅某个 PTY 的输出流（按 id 过滤共享通道）。 */
export function onPtyOutput(id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> {
  return listen<PtyOutputEvent>('pty://output', (e) => {
    if (e.payload.id === id) cb(decodeBase64(e.payload.data))
  })
}

/** 订阅某个 PTY 的退出事件。 */
export function onPtyExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen<PtyExitEvent>('pty://exit', (e) => {
    if (e.payload.id === id) cb()
  })
}
