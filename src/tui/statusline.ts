/**
 * 可脚本化 statusline — 对齐 Claude Code statusLine 协议的字段子集。
 *
 * config `ui.statusLine.command` 指定用户脚本；每次刷新把会话状态 JSON 写入
 * 脚本 stdin，取 stdout 首行渲染在输入框上方的独立行。
 *
 * 协议 payload（CC 字段子集 + rivet 扩展）：
 * ```json
 * {
 *   "session_id": "…",
 *   "model": { "display_name": "deepseek-v4" },
 *   "workspace": { "current_dir": "/path/to/project" },
 *   "git": { "branch": "main" },
 *   "context": { "ratio": 0.42, "estimated_tokens": 54000, "max_tokens": 128000 },
 *   "cost": { "total_yuan": 0.1234 },
 *   "turn": 7
 * }
 * ```
 *
 * 安全/稳态约束：
 * - 节流（默认 3s）+ 单飞（前一次未返回则跳过本次）
 * - 超时 kill（默认 2s），脚本失败/超时保留上一次输出（不闪断）
 * - 输出截断到 300 字符、去掉换行——渲染层再按终端宽度 clamp
 */

import { spawn } from 'node:child_process'

export interface StatusLinePayload {
  session_id: string
  model: { display_name: string }
  workspace: { current_dir: string }
  git?: { branch?: string }
  context?: { ratio: number; estimated_tokens?: number; max_tokens?: number }
  cost?: { total_yuan?: number }
  turn?: number
}

export interface StatusLineConfig {
  command: string
  /** 两次执行的最小间隔（毫秒）。默认 3000。 */
  intervalMs?: number
  /** 单次执行超时（毫秒），超时 kill。默认 2000。 */
  timeoutMs?: number
}

export class StatusLineRunner {
  private readonly command: string
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private lastRunMs = 0
  private inFlight = false
  private lastOutput: string | null = null

  constructor(config: StatusLineConfig, private readonly onUpdate: (text: string | null) => void) {
    this.command = config.command
    this.intervalMs = config.intervalMs ?? 3000
    this.timeoutMs = config.timeoutMs ?? 2000
  }

  /** 当前缓存的 statusline 文本（脚本 stdout 首行）。 */
  get current(): string | null {
    return this.lastOutput
  }

  /**
   * 请求刷新。节流 + 单飞；实际执行时把 payload JSON 写入脚本 stdin。
   * 失败/超时静默保留上一次输出。
   */
  refresh(payload: StatusLinePayload): void {
    const now = Date.now()
    if (this.inFlight || now - this.lastRunMs < this.intervalMs) return
    this.lastRunMs = now
    this.inFlight = true

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      this.inFlight = false
      return
    }

    let stdout = ''
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this.inFlight = false
      const firstLine = stdout.split('\n')[0]?.trim() ?? ''
      if (firstLine) {
        this.lastOutput = firstLine.slice(0, 300)
        this.onUpdate(this.lastOutput)
      }
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already dead */ }
      settle()
    }, this.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.on('error', () => settle())
    child.on('close', () => settle())
    try {
      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
    } catch { /* stdin 已关：脚本可能不读输入，无妨 */ }
  }
}
