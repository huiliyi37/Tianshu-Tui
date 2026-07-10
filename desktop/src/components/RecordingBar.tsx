import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { getRecordingStatus, stopRecording } from '../runtime/client'
import { isTauri } from '../lib/pty'
import { qk } from '../state/queries'

interface RecordingEventPayload {
  id: string
  count: number
  ts: number
  kind: string
  app: string
}

/**
 * RPA 录制常驻指示条（隐私硬约束：录制中不可关闭，只能停止）。
 * 全局挂载在 App 根部——无论用户切到哪个 surface，录制中始终可见。
 * 计数走 `recording://event` 实时推送；状态轮询兜底（应对刷新/重挂载）。
 */
export function RecordingBar() {
  const { t } = useTranslation('automations')
  const qc = useQueryClient()
  const [recording, setRecording] = useState(false)
  const [count, setCount] = useState(0)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: UnlistenFn | undefined

    const sync = async () => {
      const status = await getRecordingStatus()
      if (disposed) return
      setRecording(status.recording)
      if (status.recording) setCount(status.count)
    }

    void sync()
    const timer = setInterval(() => void sync(), 3000)
    void listen<RecordingEventPayload>('recording://event', (ev) => {
      setRecording(true)
      setCount(ev.payload.count)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      clearInterval(timer)
      unlisten?.()
    }
  }, [])

  if (!recording) return null

  const stop = async () => {
    setStopping(true)
    try {
      const summary = await stopRecording()
      setRecording(false)
      setCount(0)
      void qc.invalidateQueries({ queryKey: qk.recordings })
      toast.success(t('recorder.stopped', { count: summary.eventCount, apps: summary.apps.join(', ') || '-' }))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div
      className="recording-bar"
      style={{
        position: 'fixed',
        top: 42,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        borderRadius: 999,
        background: 'var(--panel-2, #1b1b1f)',
        border: '1px solid var(--border, #333)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: '#e5484d',
          animation: 'recording-pulse 1.2s ease-in-out infinite',
        }}
      />
      <style>{'@keyframes recording-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }'}</style>
      <span style={{ fontSize: 13 }}>{t('recorder.indicator', { count })}</span>
      <button className="btn ghost sm" disabled={stopping} onClick={() => void stop()}>
        {t('recorder.stop')}
      </button>
    </div>
  )
}
