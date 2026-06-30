import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { HardDrive, FolderOpen, Usb, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { StorageOptions } from '@/runtime/types'
import { applyStorageLocation, getStorageOptions } from '@/runtime/client'

interface StorageLocationPanelProps {
  /** Called after a successful apply. When restart is required, caller should relaunch. */
  onApplied?: (requiresRestart: boolean) => void
  /** Optional cancel / skip action (first-run dialog omits this). */
  onCancel?: () => void
}

type StorageChoice = 'default' | 'portable' | 'custom'

function compactPath(path: string, max = 55): string {
  if (path.length <= max) return path
  const start = path.slice(0, 22)
  const end = path.slice(-28)
  return `${start}…${end}`
}

export function StorageLocationPanel({ onApplied, onCancel }: StorageLocationPanelProps) {
  const [options, setOptions] = useState<StorageOptions | null>(null)
  const [choice, setChoice] = useState<StorageChoice>('default')
  const [customPath, setCustomPath] = useState('')
  const [migrate, setMigrate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getStorageOptions()
      .then((opts) => {
        setOptions(opts)
        if (opts.portablePath && opts.current === opts.portablePath) {
          setChoice('portable')
        } else if (opts.current && opts.current !== opts.defaultPath) {
          setChoice('custom')
          setCustomPath(opts.current)
        }
      })
      .catch((err) => setError(`读取存储选项失败：${(err as Error).message}`))
  }, [])

  const targetPath = useMemo(() => {
    if (!options) return ''
    if (choice === 'default') return options.defaultPath
    if (choice === 'portable') return options.portablePath ?? ''
    return customPath
  }, [choice, customPath, options])

  const canApply = !!targetPath && !busy

  const pickFolder = async () => {
    if (!options) return
    try {
      const selected = await open({
        directory: true,
        defaultPath: options.defaultPath,
      })
      if (selected && typeof selected === 'string') {
        setCustomPath(selected)
        setChoice('custom')
      }
    } catch (err) {
      setError(`选择文件夹失败：${(err as Error).message}`)
    }
  }

  const handleApply = async () => {
    if (!canApply) return
    setBusy(true)
    setError(null)
    try {
      const result = await applyStorageLocation(targetPath, migrate)
      if (!result.success) {
        setError(result.error ?? '应用存储位置失败')
        return
      }
      onApplied?.(result.requiresRestart)
    } catch (err) {
      setError(`应用存储位置失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="storage-panel">
      <div className="storage-intro">
        <p className="text-sm text-text">
          选择天枢桌面端的数据存储位置。会话日志、配置和项目知识库都会放在这里。
          首次选择后需要重启应用生效。
        </p>
      </div>

      {error && (
        <div className="storage-error">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="storage-options">
        <label
          className={`storage-option ${choice === 'default' ? 'selected' : ''}`}
        >
          <input
            type="radio"
            name="storage-choice"
            value="default"
            checked={choice === 'default'}
            onChange={() => setChoice('default')}
          />
          <HardDrive size={18} className="storage-option-icon" />
          <div className="storage-option-body">
            <span className="storage-option-title">默认位置</span>
            <span className="storage-option-path" title={options?.defaultPath}>
              {options ? compactPath(options.defaultPath) : '读取中…'}
            </span>
          </div>
        </label>

        {options?.portablePath && (
          <label
            className={`storage-option ${choice === 'portable' ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="storage-choice"
              value="portable"
              checked={choice === 'portable'}
              onChange={() => setChoice('portable')}
            />
            <Usb size={18} className="storage-option-icon" />
            <div className="storage-option-body">
              <span className="storage-option-title">便携位置（应用同目录）</span>
              <span className="storage-option-path" title={options.portablePath}>
                {compactPath(options.portablePath)}
              </span>
            </div>
          </label>
        )}

        <label
          className={`storage-option ${choice === 'custom' ? 'selected' : ''}`}
        >
          <input
            type="radio"
            name="storage-choice"
            value="custom"
            checked={choice === 'custom'}
            onChange={() => setChoice('custom')}
          />
          <FolderOpen size={18} className="storage-option-icon" />
          <div className="storage-option-body">
            <span className="storage-option-title">自定义文件夹</span>
            <span className="storage-option-path" title={customPath || undefined}>
              {customPath ? compactPath(customPath) : '点击右侧按钮选择文件夹'}
            </span>
          </div>
          {choice === 'custom' && (
            <Button size="sm" variant="outline" onClick={pickFolder} disabled={busy}>
              选择…
            </Button>
          )}
        </label>
      </div>

      <label className="storage-migrate">
        <input
          type="checkbox"
          checked={migrate}
          onChange={(e) => setMigrate(e.target.checked)}
          disabled={busy}
        />
        <span>将现有数据迁移到新位置</span>
      </label>

      <div className="storage-actions">
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
        )}
        <Button onClick={handleApply} disabled={!canApply}>
          {busy ? '应用并迁移…' : '应用并重启'}
        </Button>
      </div>
    </div>
  )
}
