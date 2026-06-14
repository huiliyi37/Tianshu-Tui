/**
 * Worker Status Panel — real-time view of delegation workers and circuit breaker state.
 *
 * Follows the same pattern as TeamPanel: pure render from a model,
 * collapsible when no workers are active.
 *
 * ┌─ Workers ──────────────────────────────┐
 * │ lint_fixer    ██████░░  75% [3/4 files] │
 * │ test_gen      ████████ done  ✓ 12 tests │
 * │ type_fixer    ░░░░░░░░ queued           │
 * │ [circuit: all closed]                   │
 * └─────────────────────────────────────────┘
 */

import React from 'react'
import { Box, Text } from 'ink'
import { getTheme } from './theme.js'
import {
  formatElapsed,
  progressBar,
  type WorkerPanelModel,
  type WorkerPanelStatus,
} from './worker-panel-model.js'

function statusGlyph(status: WorkerPanelStatus): string {
  switch (status) {
    case 'done': return '✓'
    case 'running': return '◐'
    case 'queued': return '◌'
    case 'failed': return '✗'
    case 'circuit-open': return '⊗'
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

export function renderWorkerPanelLines(model: WorkerPanelModel, width = 80): string[] {
  const inner = Math.max(44, width - 6)
  const activeCount = model.workers.filter(w => w.status === 'running').length
  const doneCount = model.workers.filter(w => w.status === 'done').length
  const stats = `${activeCount} active · ${doneCount}/${model.workers.length} done`
  const lines = [`  Workers  ${stats}`]

  if (model.workers.length === 0) {
    lines.push('    No workers active.')
  }

  for (const w of model.workers) {
    const glyph = statusGlyph(w.status)
    const name = w.profile.padEnd(16)
    let detail = ''

    if (w.progress && w.status === 'running') {
      const bar = progressBar(w.progress.current, w.progress.total)
      const pct = w.progress.total > 0 ? Math.round((w.progress.current / w.progress.total) * 100) : 0
      detail = `${bar} ${String(pct).padStart(3)}% [${w.progress.label}]`
    } else if (w.status === 'done' && w.resultSummary) {
      detail = `done  ${glyph} ${w.resultSummary}`
    } else if (w.status === 'failed' && w.error) {
      detail = `failed ${truncate(w.error, 40)}`
    } else if (w.status === 'circuit-open') {
      detail = 'circuit open — skipped'
    } else {
      detail = w.status
    }

    const elapsed = w.elapsed ? ` ${formatElapsed(w.elapsed)}` : ''
    const line = `${glyph} ${name}${truncate(detail, inner - 20)}${elapsed}`
    lines.push(`    ${truncate(line, inner)}`)
  }

  const openCircuits = model.circuits.filter(c => c.state !== 'closed')
  if (openCircuits.length > 0) {
    for (const c of openCircuits) {
      const cooldown = c.cooldownRemainingS > 0 ? ` (${c.cooldownRemainingS}s)` : ''
      lines.push(truncate(`    circuit ${c.profile}: ${c.state}${cooldown} (${c.failureCount} failures)`, inner))
    }
  }

  return lines
}

export function WorkerPanel({ model, width = 80 }: { model: WorkerPanelModel; width?: number }) {
  const theme = getTheme()
  const lines = renderWorkerPanelLines(model, width)
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, index) => {
        const color = line.includes('failed') || line.includes('circuit open') ? theme.error
          : line.includes('half-open') ? theme.warning
          : index === 0 ? theme.muted
          : theme.dim
        return <Text key={index} color={color}>{line}</Text>
      })}
    </Box>
  )
}
