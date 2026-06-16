/**
 * 工具耗时格式化 — 单一来源（tool-card 完成卡片 + collapsed 组 + live 行共用）。
 *
 * 两个变体，语义清晰区分：
 *  - formatElapsed: 精确时长（Claude Code 风 `123ms` / `1.5s` / `1m05s`），
 *    用于「已完成」工具卡片，即使快也显示精确时间。
 *  - formatToolElapsed: 整秒、<1s 返回空，用于 live 区降噪（避免快工具刷屏）。
 */

/** 精确耗时（CC 风）：<1s → `123ms`，<60s → `1.5s`，否则 `1m05s`。 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m${String(secs).padStart(2, '0')}s`
}

/**
 * Live 区降噪变体：<1s 返回空字符串，否则整秒（`4s` / `1m05s`）。
 */
export function formatToolElapsed(ms: number): string {
  if (ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
