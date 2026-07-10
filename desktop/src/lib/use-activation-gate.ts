import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getActivationStatus,
  verifyLicenseHeartbeat,
  type ActivationStatus,
} from '../runtime/client'

// Heartbeat cadence: refresh the rolling token + catch revocation. Kept
// infrequent — the offline grace period (Rust, ~10 days) tolerates gaps.
const HEARTBEAT_MS = 6 * 60 * 60 * 1000
// A short post-boot heartbeat refreshes the rolling expiry once per launch.
const BOOT_HEARTBEAT_MS = 15_000

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 双层模式（Basic 免许可证 + Pro 许可证解锁）的许可证状态驱动。
 *
 * 启动时静默查一次 Rust 验签的本地许可证，并跑滚动心跳（刷新 token /
 * 捕获吊销）。不阻塞任何 UI——Basic（无许可证）照常渲染完整工作区，
 * 状态仅供设置面板展示层级与升级入口。心跳失败 / 吊销只把状态降回
 * Basic，绝不锁死应用；Pro 能力的实际生效在 Rust spawn sidecar 时按
 * 最新许可证注入 RIVET_PRO 决定。
 *
 * In non-Tauri contexts (browser dev, jsdom tests) the hook is inert.
 */
export function useProLicense() {
  const [status, setStatus] = useState<ActivationStatus | null>(null)
  const [checked, setChecked] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setChecked(true)
      return
    }
    try {
      setStatus(await getActivationStatus())
    } catch {
      // The command should never fail under Tauri; if it does, treat as
      // Basic (status null) rather than surface an error state.
      setStatus(null)
    } finally {
      setChecked(true)
    }
  }, [])

  const isPro = status?.activated === true

  useEffect(() => {
    void refresh()
    if (!isTauri()) return

    const runHeartbeat = () => {
      void verifyLicenseHeartbeat()
        .then((r) => {
          if (!r) return
          // 吊销/过期 → 状态回落 Basic（重新查询本地状态）；成功 → 滚动续期。
          if ('revoked' in r) void refresh()
          else setStatus(r.status)
        })
        .catch(() => {})
    }

    const boot = setTimeout(runHeartbeat, BOOT_HEARTBEAT_MS)
    timer.current = setInterval(runHeartbeat, HEARTBEAT_MS)

    return () => {
      if (timer.current) clearInterval(timer.current)
      clearTimeout(boot)
    }
  }, [refresh])

  return { status, checked, refresh, isPro }
}
