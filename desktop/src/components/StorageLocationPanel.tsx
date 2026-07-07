import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('settings')
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
      .catch((err) => setError(t('storagePanel.loadFailed', { error: (err as Error).message })))
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
      setError(t('storagePanel.pickFailed', { error: (err as Error).message }))
    }
  }

  const handleApply = async () => {
    if (!canApply) return
    setBusy(true)
    setError(null)
    try {
      const result = await applyStorageLocation(targetPath, migrate)
      if (!result.success) {
        setError(result.error ?? t('storagePanel.applyFailed'))
        return
      }
      onApplied?.(result.requiresRestart)
    } catch (err) {
      setError(t('storagePanel.applyFailedWith', { error: (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="storage-panel">
      <div className="storage-intro">
        <p className="text-sm text-text">
          {t('storagePanel.intro')}
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
            <span className="storage-option-title">{t('storagePanel.default')}</span>
            <span className="storage-option-path" title={options?.defaultPath}>
              {options ? compactPath(options.defaultPath) : t('storagePanel.reading')}
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
              <span className="storage-option-title">{t('storagePanel.portable')}</span>
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
            <span className="storage-option-title">{t('storagePanel.custom')}</span>
            <span className="storage-option-path" title={customPath || undefined}>
              {customPath ? compactPath(customPath) : t('storagePanel.customEmpty')}
            </span>
          </div>
          {choice === 'custom' && (
            <Button size="sm" variant="outline" onClick={pickFolder} disabled={busy}>
              {t('storagePanel.choose')}
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
        <span>{t('storagePanel.migrate')}</span>
      </label>

      <div className="storage-actions">
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t('storagePanel.cancel')}
          </Button>
        )}
        <Button onClick={handleApply} disabled={!canApply}>
          {busy ? t('storagePanel.applying') : t('storagePanel.apply')}
        </Button>
      </div>
    </div>
  )
}
