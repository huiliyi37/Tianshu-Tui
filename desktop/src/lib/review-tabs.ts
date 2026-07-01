// Right Panel (ReviewPanel) customizable tabs preference manager (P0).
// Persisted to localStorage and broadcast via a custom event.

export type ReviewTab = 'review' | 'plan' | 'task' | 'canvas' | 'wt' | 'files' | 'github' | 'browser'

const KEY = 'tianshu.enabledReviewTabs'
const CHANGE_EVENT = 'tianshu:reviewtabschange'

export const ALL_TABS: { id: ReviewTab; label: string; glyph: string }[] = [
  { id: 'review', label: 'Changes', glyph: '✓' },
  { id: 'plan', label: 'Plan', glyph: '📋' },
  { id: 'task', label: 'Tasks', glyph: '☑' },
  { id: 'canvas', label: 'Canvas', glyph: '🎨' },
  { id: 'wt', label: 'Diff', glyph: '⟐' },
  { id: 'files', label: 'Files', glyph: '📁' },
  { id: 'github', label: 'PR', glyph: '🔀' },
  { id: 'browser', label: 'Browser', glyph: '🌐' },
]

export function loadEnabledTabs(): ReviewTab[] {
  try {
    const v = localStorage.getItem(KEY)
    if (v) {
      const parsed = JSON.parse(v) as string[]
      const valid = parsed.filter((t) => ALL_TABS.some((def) => def.id === t)) as ReviewTab[]
      if (valid.length > 0) return valid
    }
  } catch {
    // non-fatal
  }
  return ['review', 'plan', 'task', 'canvas', 'wt', 'files', 'github', 'browser'] // Default: show all
}

export function saveEnabledTabs(tabs: ReviewTab[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs))
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    // non-fatal
  }
}

import { useEffect, useState } from 'react'

export function useEnabledTabs(): [ReviewTab[], (tabs: ReviewTab[]) => void] {
  const [enabled, setEnabled] = useState(loadEnabledTabs)

  useEffect(() => {
    const onChange = () => setEnabled(loadEnabledTabs())
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])

  return [
    enabled,
    (tabs) => {
      saveEnabledTabs(tabs)
      setEnabled(tabs)
    },
  ]
}
