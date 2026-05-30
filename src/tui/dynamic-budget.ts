/**
 * Dynamic zone budget calculator.
 *
 * Ink 6 uses cursor-up differential rendering. When the dynamic zone
 * (everything below <Static>) exceeds terminal rows, cursor-up overflows
 * → entire screen flickers.
 *
 * This module provides a single source of truth for allocating rows
 * across StreamOutput, ToolCard(s), ThinkingCollapser, and chrome
 * (GlanceBar + InputBar + margins).
 *
 * Invariant: streamLines + N × cardLines + CHROME_ROWS ≤ termRows
 */

/** Fixed chrome: ThinkingCollapser(1) + GlanceBar(1) + InputBar(2) + margins(2) */
export const CHROME_ROWS = 6

/** Absolute cap on any single ToolCard (collapsed or expanded) */
export const MAX_CARD_LINES = 15

export interface DynamicBudget {
  /** Lines allocated to StreamOutput */
  streamLines: number
  /** Lines allocated to each ToolCard */
  cardLines: number
  /** Lines allocated to a single expanded ToolCard */
  expandedLines: number
}

/**
 * Compute the dynamic zone budget for a given terminal size and live tool count.
 *
 * Distribution strategy: divide (termRows - chrome) equally among
 * (liveToolCount + 1) slots — one slot for StreamOutput, one per ToolCard.
 * Each slot is capped at MAX_CARD_LINES=15.
 *
 * Expanded mode: a single expanded ToolCard gets (termRows - chrome - 1)
 * where -1 reserves a minimum 1-line stream preview.
 */
export function computeBudget(termRows: number, liveToolCount: number): DynamicBudget {
  const available = termRows - CHROME_ROWS
  const slots = liveToolCount + 1  // N cards + stream

  // Equal division, capped at MAX_CARD_LINES.
  // No minimum floor — on tiny terminals with many cards, each card
  // shrinks proportionally. This is correct: Ink flicker is worse than
  // a cramped card.
  const perSlot = Math.floor(available / slots)
  const cardLines = Math.min(MAX_CARD_LINES, Math.max(1, perSlot))

  // Stream gets the remainder after cards take their share
  const streamLines = Math.max(1, available - liveToolCount * cardLines)

  // Expanded: single card gets almost everything, stream gets min 1 line
  const expandedLines = Math.min(MAX_CARD_LINES, Math.max(cardLines, available - 1))

  return { streamLines, cardLines, expandedLines }
}
