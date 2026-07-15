import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '../lib/dialog'

const CHECK_TIMEOUT_MS = 15_000

/**
 * 启动时静默检查更新；有新版本时在顶部弹出横幅，支持一键下载安装并重启。
 * 检查/下载失败时会在横幅里显示具体原因，并允许重试。
 *
 * 仅在 Tauri 桌面环境运行（浏览器开发模式 no-op）。
 * dev 开发模式下不自动弹横幅，避免 target/debug 二进制版本 stale 时反复提示。
 */
export function UpdateBanner() {
  // dev 模式下跳过自动检查：Settings → About 的 App version 以 Rust 二进制为准，
  // 开发时若未重新编译，二进制内嵌版本可能落后于前端/源码，导致误报。
  if (import.meta.env.DEV) return null
  const { t } = useTranslation('shell')
  const [update, setUpdate] = useState<Update | null>(null)
  const [installing, setInstalling] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState<{ phase: 'check' | 'download'; key: string } | null>(null)
  const checkAbortRef = useRef<AbortController | null>(null)

  const runCheck = async () => {
    if (!isTauri()) return
    checkAbortRef.current?.abort()
    const controller = new AbortController()
    checkAbortRef.current = controller

    setError(null)
    setUpdate(null)

    try {
      const timeout = new Promise<never>((_, reject) => {
        const id = setTimeout(() => {
          controller.abort()
          reject(new Error('timeout'))
        }, CHECK_TIMEOUT_MS)
        controller.signal.addEventListener('abort', () => clearTimeout(id), { once: true })
      })
      const result = await Promise.race([check(), timeout])
      if (!controller.signal.aborted && result) {
        setUpdate(result)
      }
    } catch (err) {
      if (controller.signal.aborted) return
      setError({ phase: 'check', key: resolveErrorKey(err) })
    } finally {
      if (checkAbortRef.current === controller) {
        checkAbortRef.current = null
      }
    }
  }

  useEffect(() => {
    // 延迟一点，避免与启动期 sidecar spawn 抢资源
    const timer = setTimeout(() => { void runCheck() }, 4000)
    return () => {
      clearTimeout(timer)
      checkAbortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = async () => {
    if (!update) return
    setInstalling(true)
    setRestarting(false)
    setProgress(0)
    setError(null)
    let total = 0
    let downloaded = 0
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0
            break
          case 'Progress':
            downloaded += event.data.chunkLength ?? 0
            setProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null)
            break
          case 'Finished':
            // 进入"重启中"过渡态：下载安装已完成、relaunch 即将执行。
            // 先把 installing 置 false 并显示完成提示，避免 relaunch 前盲等
            // 让用户以为卡住（relaunch 会替换进程，此态是最后一帧 UI）。
            setProgress(100)
            setInstalling(false)
            setRestarting(true)
            break
        }
      })
      await relaunch()
    } catch (err) {
      setInstalling(false)
      setRestarting(false)
      setProgress(null)
      setError({ phase: 'download', key: resolveErrorKey(err) })
    }
  }

  if (dismissed) return null

  const busy = installing || restarting

  return (
    <div className={`update-banner${error ? ' error' : ''}`}>
      <div className="update-banner-text">
        {error ? (
          <>
            {t(error.phase === 'check' ? 'update.checkFailed' : 'update.downloadFailed')}
            {': '}
            {t(error.key as any)}
          </>
        ) : restarting ? (
          t('update.restarting')
        ) : (
          <>
            <Trans
              t={t}
              i18nKey="update.newVersion"
              values={{ version: update?.version ?? '' }}
              components={{ bold: <strong /> }}
            />
            {installing && progress != null && ` · ${t('update.downloading', { progress })}`}
            {installing && progress == null && ` · ${t('update.installing')}`}
          </>
        )}
      </div>
      <div className="update-banner-actions">
        {error ? (
          <>
            <button className="btn sm" onClick={error.phase === 'check' ? () => { void runCheck() } : install}>
              {t('update.retry')}
            </button>
            <button className="btn ghost sm" onClick={() => setDismissed(true)}>
              {t('update.dismiss')}
            </button>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={install} disabled={busy || !update}>
              {restarting ? t('update.restartingBtn') : installing ? t('update.pleaseWait') : t('update.updateNow')}
            </button>
            <button className="btn ghost sm" onClick={() => setDismissed(true)} disabled={busy}>
              {t('update.later')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function resolveErrorKey(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (lower.includes('timeout')) return 'update.timeoutError'
  if (lower.includes('network') || lower.includes('offline') || lower.includes('connection') || lower.includes('econnrefused')) {
    return 'update.networkError'
  }
  if (lower.includes('signature') || lower.includes('verify') || lower.includes('pubkey') || lower.includes('invalid signature')) {
    return 'update.signatureError'
  }
  if (lower.includes('http') || lower.includes('404') || lower.includes('500') || lower.includes('503') || lower.includes('server')) {
    return 'update.serverError'
  }
  return 'update.unknownError'
}
