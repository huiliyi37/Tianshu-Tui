import { useEffect, useState } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '../lib/dialog'

/**
 * 启动时静默检查更新；有新版本时在顶部弹出横幅，支持一键下载安装并重启。
 * 检查失败（如更新服务器未配置）静默吞掉，不打扰用户。
 *
 * 仅在 Tauri 桌面环境运行（浏览器开发模式 no-op）。
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    // 延迟一点，避免与启动期 sidecar spawn 抢资源
    const timer = setTimeout(async () => {
      try {
        const result = await check()
        if (!cancelled && result) setUpdate(result)
      } catch {
        // 更新服务器未配置或网络不可达 — 静默
      }
    }, 4000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  const install = async () => {
    if (!update) return
    setInstalling(true)
    setProgress(0)
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
            setProgress(100)
            break
        }
      })
      await relaunch()
    } catch {
      setInstalling(false)
      setProgress(null)
    }
  }

  if (!update || dismissed) return null

  return (
    <div className="update-banner">
      <div className="update-banner-text">
        新版本 <strong>{update.version}</strong> 可用
        {installing && progress != null && ` · 下载中 ${progress}%`}
        {installing && progress == null && ' · 安装中…'}
      </div>
      <div className="update-banner-actions">
        <button className="btn sm" onClick={install} disabled={installing}>
          {installing ? '请稍候' : '立即更新'}
        </button>
        <button className="btn ghost sm" onClick={() => setDismissed(true)} disabled={installing}>
          稍后
        </button>
      </div>
    </div>
  )
}
