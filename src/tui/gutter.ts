import type { RivetTheme } from './theme.js'

export type GutterKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'system'

/** Single-char gutter glyph + the theme color key used to render it. */
export const GUTTER: Record<GutterKind, { glyph: string; colorKey: keyof RivetTheme }> = {
  user: { glyph: '▍', colorKey: 'userColor' },
  assistant: { glyph: '▍', colorKey: 'assistantColor' },
  thinking: { glyph: '┊', colorKey: 'muted' },
  tool: { glyph: '│', colorKey: 'primary' },
  system: { glyph: '·', colorKey: 'systemColor' },
}

export function gutterGlyph(kind: GutterKind): string {
  return (GUTTER[kind] ?? GUTTER.system).glyph
}
