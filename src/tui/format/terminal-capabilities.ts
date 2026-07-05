/**
 * T9 终端能力检测 — WSL 兼容。
 *
 * chalk.level 基于 process.env.TERM 自动检测，在 WSL 中可能不准确：
 * TERM=xterm-256color 但底层 conhost 可能不支持真正的 256 色，
 * 导致 Unicode spinner 字符乱码。
 *
 * 本模块提供一个保守的检测：当 TERM 为 "linux"（conhost 典型值）或
 * COLORTERM 不包含 truecolor/256 时，降级为 ASCII fallback。
 */

import chalk from 'chalk'

/**
 * 是否应使用 ASCII fallback（而非 Unicode 图形符号）。
 * 在以下情况返回 true：
 * - chalk.level < 3（无真彩色支持）
 * - TERM=linux（conhost 典型值，256 色支持不可靠）
 * - COLORTERM 明确不含 truecolor/256
 */
export function shouldUseAsciiFallback(): boolean {
  if (chalk.level < 3) return true

  const term = (process.env.TERM ?? '').toLowerCase()
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase()

  // conhost 通常报告 TERM=linux，其 256 色支持不可靠
  if (term === 'linux') return true

  // 若 COLORTERM 明确声明支持 truecolor/256，则信任 chalk
  if (colorterm.includes('truecolor') || colorterm.includes('256')) return false

  // 其他情况保守降级：如果 COLORTERM 存在但不包含 truecolor/256，
  // 说明终端可能不支持完整色彩，使用 ASCII fallback
  if (colorterm.length > 0) return true

  return false
}
