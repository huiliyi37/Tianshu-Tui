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
 * Drives the desktop activation gate. Queries the Rust-verified local license
 * on boot, listens for the `activation-required` event (runtime revocation),
 * and runs a periodic /verify heartbeat. Returns `gated=true` when the app
 * should render the activation screen instead of the workspace.
 *
 * In non-Tauri contexts (browser dev, jsdom tests) the gate is inert.
 */
export function useActivationGate() {
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
      // The command should never fail under Tauri; if it does, don't brick the
      // app — leave status null (ungated) rather than lock out on a glitch.
      setStatus(null)
    } finally {
      setChecked(true)
    }
  }, [])

  // 当 Rust 编译时关闭激活 gate（release 未设 RIVET_ACTIVATION_ENABLED=1）时，
  // activation_status 返回 reason === 'disabled'，前端应彻底跳过激活 UI 与心跳。
  const disabled = status?.reason === 'disabled'
  const gated = isTauri() && checked && status != null && !status.activated && !disabled

  useEffect(() => {
    void refresh()
    // 激活被编译时关闭时，不监听 revocation 事件也不跑心跳。
    if (!isTauri() || disabled) return

    let offEvent: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(async (m) => {
        offEvent = await m.listen('activation-required', () => {
          void refresh()
        })
      })
      .catch(() => {})

    const runHeartbeat = () => {
      void verifyLicenseHeartbeat()
        .then((r) => {
          if (!r) return
          if ('revoked' in r) void refresh()
          else setStatus(r.status)
        })
        .catch(() => {})
    }

    const boot = setTimeout(runHeartbeat, BOOT_HEARTBEAT_MS)
    timer.current = setInterval(runHeartbeat, HEARTBEAT_MS)

    return () => {
      if (offEvent) offEvent()
      if (timer.current) clearInterval(timer.current)
      clearTimeout(boot)
    }
  }, [refresh, disabled])

  return { gated, status, checked, refresh, disabled }
}
