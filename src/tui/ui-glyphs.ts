/**
 * 高频 UI chrome 的宽度稳定字形。
 *
 * 核心界面不使用彩色 emoji：它们由宿主字体决定颜色与字面，通常占两列，
 * 会让主题语义色失效。legacy 终端继续走纯 ASCII 降级。
 */

import { useAsciiGlyphs } from './term-caps.js'

export interface UiGlyphs {
  readonly sideQuestion: string
  readonly planSubmitted: string
  readonly planApproved: string
  readonly planRejected: string
  readonly planExecuted: string
}

const UNICODE_GLYPHS = {
  sideQuestion: '◇',
  planSubmitted: '◇',
  planApproved: '✓',
  planRejected: '✗',
  planExecuted: '◆',
} as const satisfies UiGlyphs

const ASCII_GLYPHS = {
  sideQuestion: '?',
  planSubmitted: '-',
  planApproved: '+',
  planRejected: 'x',
  planExecuted: '*',
} as const satisfies UiGlyphs

export function uiGlyphs(): UiGlyphs {
  return useAsciiGlyphs() ? ASCII_GLYPHS : UNICODE_GLYPHS
}
