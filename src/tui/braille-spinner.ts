const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Smooth braille spinner frame for a monotonically increasing tick index (S16). */
export function brailleSpinnerFrame(tick: number): string {
  return FRAMES[((tick % FRAMES.length) + FRAMES.length) % FRAMES.length]!
}

// Rotating circle (moon-phase) — the "圆图标" used for the Thinking indicator.
// Same visual vocabulary as the footer streaming dot for a consistent feel.
const CIRCLE_FRAMES = ['◐', '◓', '◑', '◒'] as const

/** Rotating circle spinner frame for a monotonically increasing tick index. */
export function circleSpinnerFrame(tick: number): string {
  return CIRCLE_FRAMES[((tick % CIRCLE_FRAMES.length) + CIRCLE_FRAMES.length) % CIRCLE_FRAMES.length]!
}
