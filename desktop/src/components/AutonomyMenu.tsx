import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  AUTONOMY_LEVELS,
  LEVEL_META,
  fullDiskRootPath,
  isFullDiskRoot,
  type AccessChoice,
  type AutonomyLevel,
} from '../lib/autonomy'
import { getPermissionDirs, setPermissionDirs } from '../runtime/client'

/**
 * Cursor-style access-level dropdown for the composer (replaces the segmented
 * AutonomyControl there). Four tiers: 监督 / 默认 / 自治 / 完全访问.
 *
 * 完全访问 = autonomous approval mode + a standing whole-disk READ grant
 * (permissions.additionalReadDirs gets the filesystem root, applied live to
 * the running sidecar). Switching away removes the root grant from config;
 * the in-memory grant persists until the sidecar restarts, which we surface
 * via a toast.
 */
export function AutonomyMenu(props: {
  value: AutonomyLevel
  onChange: (level: AutonomyLevel) => void
  disabled?: boolean
}) {
  const { value, onChange, disabled } = props
  const { t } = useTranslation('autonomy')
  const [open, setOpen] = useState(false)
  // null = grants not loaded yet → render as plain autonomy level.
  const [fullDiskRead, setFullDiskRead] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void getPermissionDirs()
      .then((d) => { if (alive) setFullDiskRead(d.readDirs.some((x) => isFullDiskRoot(x.path))) })
      .catch(() => { if (alive) setFullDiskRead(false) })
    return () => { alive = false }
  }, [])

  const choice: AccessChoice = value === 'autonomous' && fullDiskRead ? 'full-access' : value

  const applyFullDisk = useCallback(async (enable: boolean) => {
    try {
      const current = await getPermissionDirs()
      const reads = current.readDirs.map((d) => d.path)
      const writes = current.writeDirs.map((d) => d.path)
      if (enable) {
        const root = fullDiskRootPath()
        if (!reads.some((p) => isFullDiskRoot(p))) {
          await setPermissionDirs({ additionalReadDirs: [...reads, root], additionalWriteDirs: writes })
        }
        setFullDiskRead(true)
        toast.success(t('fullAccessGranted'))
      } else {
        const kept = reads.filter((p) => !isFullDiskRoot(p))
        if (kept.length !== reads.length) {
          const saved = await setPermissionDirs({ additionalReadDirs: kept, additionalWriteDirs: writes })
          if (saved.restartRequired) toast.info(t('fullAccessRevokedRestart'))
        }
        setFullDiskRead(false)
      }
    } catch (err) {
      toast.error(t('fullAccessError', { message: (err as Error).message }))
      // Re-probe so the trigger reflects what actually stuck.
      void getPermissionDirs()
        .then((d) => setFullDiskRead(d.readDirs.some((x) => isFullDiskRoot(x.path))))
        .catch(() => {})
    }
  }, [t])

  const select = (next: AccessChoice) => {
    if (next === choice) return
    if (next === 'full-access') {
      onChange('autonomous')
      void applyFullDisk(true)
    } else {
      onChange(next)
      if (fullDiskRead) void applyFullDisk(false)
    }
  }

  const triggerMeta = choice === 'full-access'
    ? { glyph: '⚠', label: t('fullAccess') }
    : { glyph: LEVEL_META[choice].glyph, label: LEVEL_META[choice].label }
  const elevated = choice === 'autonomous' || choice === 'full-access'

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={`access-trigger ${elevated ? 'elevated' : ''}`}
        aria-label={t('groupAria')}
        aria-haspopup="menu"
        disabled={disabled}
      >
        <span className="access-glyph" aria-hidden>{triggerMeta.glyph}</span>
        {triggerMeta.label}
        <span className="access-caret" aria-hidden>{open ? '▴' : '▾'}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={6} className="min-w-64">
        <DropdownMenuRadioGroup value={choice} onValueChange={(v) => select(v as AccessChoice)}>
          {AUTONOMY_LEVELS.map((lvl) => (
            <AccessItem
              key={lvl}
              value={lvl}
              glyph={LEVEL_META[lvl].glyph}
              label={LEVEL_META[lvl].label}
              desc={LEVEL_META[lvl].hint}
            />
          ))}
          <AccessItem
            value="full-access"
            glyph="⚠"
            label={t('fullAccess')}
            desc={t('fullAccessHint')}
            warn
          />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccessItem(props: {
  value: AccessChoice
  glyph: string
  label: string
  desc: string
  warn?: boolean
}) {
  const { value, glyph, label, desc, warn } = props
  return (
    <DropdownMenuRadioItem value={value} className="items-start py-1.5">
      <span
        className={`inline-flex w-4 justify-center mt-0.5 ${warn ? 'text-warning' : 'text-muted-foreground'}`}
        style={warn ? { color: 'var(--warning)' } : undefined}
        aria-hidden
      >
        {glyph}
      </span>
      <span className="flex flex-col gap-0.5 pr-2">
        <span className={warn ? 'font-medium' : undefined}>{label}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </span>
    </DropdownMenuRadioItem>
  )
}
