/**
 * 终端背景明暗检测 — `theme: "auto"` 支撑。
 *
 * 检测链（先到先得）：
 * 1. OSC 11 查询终端背景色（`ESC ] 11 ; ? BEL`）——现代终端（iTerm2/kitty/
 *    WezTerm/Windows Terminal/Ghostty…）会回 `ESC ] 11 ; rgb:RRRR/GGGG/BBBB`，
 *    按感知亮度判明暗。500ms 超时。
 * 2. COLORFGBG 环境变量兜底（rxvt 系约定 `<fg>;<bg>`，bg 7/15 视为亮）。
 * 3. 全部失败 → 'dark'（终端世界的保守默认）。
 *
 * 必须在 TUI 接管 stdin 之前调用（startup 阶段），内部临时开 raw mode 读响应，
 * 结束后恢复原状。非 TTY（管道/CI）直接走 env 兜底。
 */

export type TerminalBackground = 'dark' | 'light'

/** 解析 OSC 11 响应中的 rgb 载荷 → 感知亮度 [0,1]。无法解析返回 null。 */
export function parseOsc11Luminance(response: string): number | null {
  // 形如 rgb:dcdc/dcdc/dcdc（每分量 1-4 位十六进制，按位宽归一化）
  const m = response.match(/rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/)
  if (!m) return null
  const norm = (s: string): number => parseInt(s, 16) / (16 ** s.length - 1)
  const r = norm(m[1]!), g = norm(m[2]!), b = norm(m[3]!)
  // ITU-R BT.601 感知亮度
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** COLORFGBG 兜底解析（如 "15;0" / "0;15" / "12;8"）。无法判断返回 null。 */
export function parseColorFgBg(env: string | undefined): TerminalBackground | null {
  if (!env) return null
  const parts = env.split(';')
  const bgRaw = parts[parts.length - 1]?.trim()
  if (!bgRaw || !/^\d+$/.test(bgRaw)) return null
  const bgIndex = Number(bgRaw)
  // ANSI 索引 7（白）/ 15（亮白）为亮背景；其余按暗处理。
  return bgIndex === 7 || bgIndex === 15 ? 'light' : 'dark'
}

export interface DetectBackgroundOptions {
  /** OSC 11 响应等待上限（毫秒）。默认 500。 */
  timeoutMs?: number
  /** 注入的 stdin/stdout（测试用）。默认 process 全局流。 */
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  env?: NodeJS.ProcessEnv
}

/**
 * 检测终端背景明暗。见模块头注释的检测链。
 * 任何异常（raw mode 失败、流关闭…）都吞掉并落到兜底，绝不让主题检测拦死启动。
 */
export async function detectTerminalBackground(opts: DetectBackgroundOptions = {}): Promise<TerminalBackground> {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const env = opts.env ?? process.env
  const timeoutMs = opts.timeoutMs ?? 500

  const fallback = (): TerminalBackground => parseColorFgBg(env.COLORFGBG) ?? 'dark'

  if (!stdin.isTTY || !stdout.isTTY) return fallback()

  const wasRaw = stdin.isRaw === true
  try {
    const result = await new Promise<TerminalBackground | null>(resolve => {
      let buffer = ''
      let done = false
      const finish = (value: TerminalBackground | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        stdin.off('data', onData)
        try { if (!wasRaw) stdin.setRawMode(false) } catch { /* 恢复失败不致命 */ }
        stdin.pause()
        resolve(value)
      }
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('latin1')
        // 响应终止符：BEL (\x07) 或 ST (ESC \)
        if (/\]11;.*(\x07|\x1B\\)/.test(buffer)) {
          const lum = parseOsc11Luminance(buffer)
          finish(lum === null ? null : (lum > 0.5 ? 'light' : 'dark'))
        }
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      try {
        if (!wasRaw) stdin.setRawMode(true)
        stdin.resume()
        stdin.on('data', onData)
        stdout.write('\x1B]11;?\x07')
      } catch {
        finish(null)
      }
    })
    return result ?? fallback()
  } catch {
    return fallback()
  }
}

/** auto 主题的默认落点：dark → cobalt，light → paper。 */
export function autoThemeFor(background: TerminalBackground): 'cobalt' | 'paper' {
  return background === 'light' ? 'paper' : 'cobalt'
}
