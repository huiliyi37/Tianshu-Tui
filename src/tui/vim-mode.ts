export type VimMode = 'normal' | 'insert' | 'visual'

export interface VimContext {
  cursor: number
  text: string
}

export class VimState {
  mode: VimMode
  cursor: number
  text: string
  pending: string

  constructor(mode: VimMode = 'insert', ctx?: Partial<VimContext>) {
    this.mode = mode
    this.cursor = ctx?.cursor ?? 0
    this.text = ctx?.text ?? ''
    this.pending = ''
  }
}

interface KeyEvent {
  key: string
  pending?: string
}

function nextWordBoundary(text: string, pos: number): number {
  let i = pos
  while (i < text.length && text[i] !== ' ') i++
  while (i < text.length && text[i] === ' ') i++
  return Math.min(i, text.length)
}

function prevWordBoundary(text: string, pos: number): number {
  let i = pos - 1
  while (i > 0 && text[i - 1] === ' ') i--
  while (i > 0 && text[i - 1] !== ' ') i--
  return Math.max(0, i)
}

export function processVimKey(state: VimState, event: KeyEvent): VimState {
  const s: VimState = {
    mode: state.mode,
    cursor: state.cursor,
    text: state.text,
    pending: state.pending,
  }

  if (event.key === 'escape') {
    s.mode = 'normal'
    s.pending = ''
    return s
  }

  if (s.mode === 'insert') return s

  const { key } = event
  const pending = event.pending ?? s.pending

  if (key === 'i') { s.mode = 'insert'; return s }
  if (key === 'a') { s.mode = 'insert'; s.cursor = Math.min(s.cursor + 1, s.text.length); return s }
  if (key === 'A') { s.mode = 'insert'; s.cursor = s.text.length; return s }
  if (key === 'I') { s.mode = 'insert'; s.cursor = 0; return s }
  if (key === 'h') { s.cursor = Math.max(0, s.cursor - 1); return s }
  if (key === 'l') { s.cursor = Math.min(s.text.length - 1, Math.max(0, s.cursor + 1)); return s }
  if (key === '0') { s.cursor = 0; return s }
  if (key === '$') { s.cursor = Math.max(0, s.text.length - 1); return s }
  if (key === 'w') { s.cursor = nextWordBoundary(s.text, s.cursor); return s }
  if (key === 'b') { s.cursor = prevWordBoundary(s.text, s.cursor); return s }
  if (key === 'd' && pending === 'd') { s.text = ''; s.cursor = 0; s.pending = ''; return s }
  if (key === 'd') { s.pending = 'd'; return s }
  if (key === 'x') {
    s.text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1)
    s.cursor = Math.min(s.cursor, Math.max(0, s.text.length - 1))
    return s
  }
  s.pending = ''
  return s
}
