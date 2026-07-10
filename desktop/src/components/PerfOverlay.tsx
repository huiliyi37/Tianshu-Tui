/**
 * Wave 0 — Performance budget overlay.
 *
 * Dev-only React portal that shows p50/p99/max for each instrumented metric.
 * Toggled via Cmd+Shift+P (macOS) / Ctrl+Shift+P (Windows). Polls the perf
 * store at 500ms; tree-shaken in production builds via __DEV_INSTRUMENT__.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  subscribePerf,
  getPerfSnapshot,
  getFpsMetric,
  startFpsTracking,
  stopFpsTracking,
  type PerfMetric,
} from '../state/perf-budget'

const isDev = import.meta.env?.DEV ?? false

export function PerfOverlay() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!isDev) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Start/stop FPS tracking based on visibility.
  useEffect(() => {
    if (visible) startFpsTracking()
    else stopFpsTracking()
    return () => stopFpsTracking()
  }, [visible])

  if (!isDev || !visible) return null

  return createPortal(<OverlayBody />, document.body)
}

function OverlayBody() {
  const snapshot = useSyncExternalStore(subscribePerf, getPerfSnapshot, getPerfSnapshot)
  const [, forceTick] = useState(0)

  // Refresh FPS (not in the external store) at 500ms.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])

  const fps = getFpsMetric()
  const entries = Object.entries(snapshot).sort((a, b) => b[1].p99 - a[1].p99)

  return (
    <div style={{
      position: 'fixed', right: 12, bottom: 12, zIndex: 99999,
      background: 'rgba(0,0,0,0.88)', color: '#0f0', borderRadius: 8,
      padding: '10px 14px', fontFamily: 'ui-monospace, monospace', fontSize: 11,
      minWidth: 260, maxHeight: '60vh', overflowY: 'auto',
      border: '1px solid rgba(0,255,0,0.2)', lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: '#0ff' }}>
        PERF BUDGET <span style={{ opacity: 0.5, fontWeight: 400 }}>Cmd+Shift+P</span>
      </div>
      {fps && (
        <div style={{ marginBottom: 6, color: '#ff0' }}>
          FPS p50:{fps.p50.toFixed(0)} p99:{fps.p99.toFixed(0)} max:{fps.max.toFixed(0)}
        </div>
      )}
      {entries.length === 0 && <div style={{ opacity: 0.4 }}>No samples yet</div>}
      {entries.map(([name, m]) => (
        <MetricRow key={name} name={name} m={m} />
      ))}
    </div>
  )
}

function MetricRow({ name, m }: { name: string; m: PerfMetric }) {
  const p50Color = m.p50 < 5 ? '#0f0' : m.p50 < 16 ? '#ff0' : '#f44'
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <span style={{ minWidth: 120, opacity: 0.7 }}>{name}</span>
      <span style={{ color: p50Color, minWidth: 50, textAlign: 'right' }}>
        {m.p50.toFixed(1)}ms
      </span>
      <span style={{ color: '#888', minWidth: 55, textAlign: 'right' }}>
        p99:{m.p99.toFixed(1)}
      </span>
      <span style={{ color: '#666', minWidth: 50, textAlign: 'right' }}>
        max:{m.max.toFixed(1)}
      </span>
      <span style={{ color: '#555' }}>({m.count})</span>
    </div>
  )
}
