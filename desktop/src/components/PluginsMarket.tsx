import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  listPluginPresets, listInstalledPlugins, installPlugin, preflightPluginInstall,
  setPluginEnabled, removePlugin,
  type PluginPreset, type InstalledPlugin, type PluginManifestPreview,
} from '../runtime/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Deterministic tile hue class (same scheme as the skills store). */
function tileClass(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `tile-${h % 6}`
}

type PermissionFlags = { fs?: boolean; net?: boolean; shell?: boolean }

/** Install-confirm dialog target: a catalog preset (manifest known from the
 *  catalog) or a custom local path (manifest from the REST preflight). */
type ConfirmTarget =
  | { kind: 'preset'; preset: PluginPreset }
  | { kind: 'custom'; path: string; manifest: PluginManifestPreview }

function PermissionChips({ permissions }: { permissions: PermissionFlags | undefined }) {
  const { t } = useTranslation('plugins')
  const flags: Array<{ key: keyof PermissionFlags; label: string }> = [
    { key: 'fs', label: t('permissions.fs') },
    { key: 'net', label: t('permissions.net') },
    { key: 'shell', label: t('permissions.shell') },
  ]
  const active = flags.filter((f) => permissions?.[f.key])
  if (active.length === 0) {
    return <span className="plugin-perm-chip none">{t('permissions.none')}</span>
  }
  return (
    <>
      {active.map((f) => (
        <span key={f.key} className={`plugin-perm-chip perm-${f.key}`}>{f.label}</span>
      ))}
    </>
  )
}

/**
 * Plugins market tab（扩展中心）— discovery grid over the static first-party
 * catalog (GET /plugins/presets) + installed list (GET /plugins/installed,
 * includes non-preset plugins). Install goes through an explicit permissions
 * review dialog (the REST confirm semantics), enable/disable is optimistic
 * with rollback. Everything takes effect on the NEXT session — plugins join
 * the tool list in the system prompt, and mid-session changes would shatter
 * the prefix cache.
 *
 * Preset installPath values like `plugins/office-pdf` resolve against the repo
 * root in dev, and against the packaged `resources/plugins/` tree (via
 * RIVET_BUNDLED_PLUGINS_DIR / bundledPluginsDir) in Tauri builds.
 */
export function PluginsMarket() {
  const { t } = useTranslation('plugins')
  const [presets, setPresets] = useState<PluginPreset[] | null>(null)
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [confirmRemoveName, setConfirmRemoveName] = useState<string | null>(null)
  const [customPath, setCustomPath] = useState('')
  const [preflighting, setPreflighting] = useState(false)

  const fetchAll = useCallback(() => {
    listPluginPresets()
      .then((r) => { setPresets(r.presets); setError(null) })
      .catch((err) => setError((err as Error).message))
    listInstalledPlugins()
      .then((r) => setInstalled(r.plugins))
      .catch((err) => setError((err as Error).message))
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const markInstalling = (id: string, on: boolean) => {
    setInstalling((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const doInstall = useCallback((sourcePath: string, displayName: string) => {
    setConfirmTarget(null)
    markInstalling(displayName, true)
    installPlugin(sourcePath)
      .then((r) => {
        setNotice(r.message ?? t('notice.installed', { name: displayName }))
        fetchAll()
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => markInstalling(displayName, false))
  }, [fetchAll, t])

  const toggle = useCallback((name: string, enabled: boolean) => {
    // Optimistic update on both lists; rollback on failure.
    setInstalled((prev) => prev?.map((p) => p.name === name ? { ...p, enabled } : p) ?? prev)
    setPresets((prev) => prev?.map((p) => p.id === name ? { ...p, enabled } : p) ?? prev)
    setPluginEnabled(name, enabled)
      .then((r) => { if (r.message) setNotice(r.message) })
      .catch((err) => {
        setInstalled((prev) => prev?.map((p) => p.name === name ? { ...p, enabled: !enabled } : p) ?? prev)
        setPresets((prev) => prev?.map((p) => p.id === name ? { ...p, enabled: !enabled } : p) ?? prev)
        setError((err as Error).message)
      })
  }, [])

  const remove = useCallback((name: string) => {
    if (confirmRemoveName !== name) {
      setConfirmRemoveName(name)
      return
    }
    setConfirmRemoveName(null)
    removePlugin(name)
      .then((r) => {
        setNotice(r.message ?? t('notice.removed', { name }))
        fetchAll()
      })
      .catch((err) => setError((err as Error).message))
  }, [confirmRemoveName, fetchAll, t])

  const preflightCustom = useCallback(() => {
    const path = customPath.trim()
    if (!path) return
    setPreflighting(true)
    preflightPluginInstall(path)
      .then((r) => {
        if (r.ok && r.manifest) {
          setConfirmTarget({ kind: 'custom', path, manifest: r.manifest })
          setError(null)
        } else {
          setError(r.error ?? t('customPath.preflightFailed'))
        }
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setPreflighting(false))
  }, [customPath, t])

  const installedNames = new Set((installed ?? []).map((p) => p.name))
  const discover = (presets ?? []).filter((p) => !installedNames.has(p.id))
  const loading = presets === null && installed === null && !error

  const renderInstalledCard = (p: InstalledPlugin) => (
    <div key={p.name} className={`skill-store-card plugin-card${p.enabled ? ' enabled' : ''}`}>
      <div className="skill-store-head">
        <div className={`skill-tile ${tileClass(p.name)}`} aria-hidden>
          {p.name.slice(0, 1).toUpperCase()}
        </div>
        <button
          className={`skill-toggle ${p.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={p.enabled}
          aria-label={p.enabled ? t('card.disableAria', { name: p.name }) : t('card.enableAria', { name: p.name })}
          onClick={() => toggle(p.name, !p.enabled)}
        >
          <span className="skill-toggle-knob" />
        </button>
      </div>
      <div className="skill-store-name">{p.name} <span className="plugin-version">v{p.version}</span></div>
      <div className="skill-store-desc">{p.description || t('card.noDescription')}</div>
      {p.toolNames.length > 0 && (
        <div className="plugin-tools">{p.toolNames.map((n) => <code key={n}>{n}</code>)}</div>
      )}
      <div className="skill-store-foot">
        <PermissionChips permissions={presetPermissionsFor(p.name)} />
        <button
          className={`plugin-remove-btn${confirmRemoveName === p.name ? ' confirm' : ''}`}
          onClick={() => remove(p.name)}
        >
          {confirmRemoveName === p.name ? t('card.confirmRemove') : t('card.remove')}
        </button>
      </div>
    </div>
  )

  function presetPermissionsFor(name: string): PermissionFlags | undefined {
    return (presets ?? []).find((p) => p.id === name)?.permissions
  }

  const renderDiscoverCard = (p: PluginPreset) => {
    const busy = installing.has(p.name) || installing.has(p.id)
    return (
      <div key={p.id} className="skill-store-card plugin-card discover">
        <div className="skill-store-head">
          <div className={`skill-tile ${tileClass(p.id)}`} aria-hidden>
            {p.name.slice(0, 1).toUpperCase()}
          </div>
          <button
            className="skills-install-action"
            disabled={busy}
            onClick={() => setConfirmTarget({ kind: 'preset', preset: p })}
          >
            {busy ? t('card.installing') : t('card.install')}
          </button>
        </div>
        <div className="skill-store-name">{p.name}</div>
        <div className="skill-store-desc">{p.description || t('card.noDescription')}</div>
        {p.tools.length > 0 && (
          <div className="plugin-tools">{p.tools.map((n) => <code key={n}>{n}</code>)}</div>
        )}
        <div className="skill-store-foot">
          <span className={`skill-src-chip cat-${p.category}`}>{t(`category.${p.category}`)}</span>
          <PermissionChips permissions={p.permissions} />
        </div>
      </div>
    )
  }

  const confirmName = confirmTarget?.kind === 'preset'
    ? confirmTarget.preset.name
    : confirmTarget?.manifest.name ?? ''
  const confirmPermissions = confirmTarget?.kind === 'preset'
    ? confirmTarget.preset.permissions
    : confirmTarget?.manifest.permissions
  const confirmTools = confirmTarget?.kind === 'preset'
    ? confirmTarget.preset.tools
    : (confirmTarget?.manifest.tools ?? []).map((tool) => tool.name)

  return (
    <div className="plugins-market">
      <div className="plugins-intro meta">{t('intro')}</div>

      {loading && (
        <div className="skills-empty-hero"><div className="skills-empty-glyph spin" aria-hidden>◌</div><p>{t('loading')}</p></div>
      )}
      {error && <div className="meta warn">{error}</div>}
      {notice && (
        <div className="meta warn skills-install-notice">
          <span>{notice}</span>
        </div>
      )}

      {(installed?.length ?? 0) > 0 && (
        <>
          <div className="skills-group-label">{t('sections.installed')}</div>
          <div className="skills-grid">{installed!.map(renderInstalledCard)}</div>
        </>
      )}

      {discover.length > 0 && (
        <>
          <div className="skills-group-label">{t('sections.discover')}</div>
          <div className="skills-grid">{discover.map(renderDiscoverCard)}</div>
        </>
      )}

      {!loading && (installed?.length ?? 0) === 0 && discover.length === 0 && !error && (
        <div className="skills-empty-hero">
          <div className="skills-empty-glyph" aria-hidden>◇</div>
          <p>{t('empty')}</p>
        </div>
      )}

      <div className="plugin-custom-install">
        <div className="skills-group-label">{t('customPath.title')}</div>
        <div className="plugin-custom-row">
          <input
            className="skills-search"
            type="text"
            placeholder={t('customPath.placeholder')}
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') preflightCustom() }}
          />
          <button
            className="btn sm"
            disabled={!customPath.trim() || preflighting}
            onClick={preflightCustom}
          >
            {preflighting ? t('customPath.checking') : t('customPath.review')}
          </button>
        </div>
      </div>

      <Dialog open={confirmTarget !== null} onOpenChange={(open) => { if (!open) setConfirmTarget(null) }}>
        <DialogContent className="skill-detail-dialog plugin-confirm-dialog">
          {confirmTarget && (
            <>
              <DialogHeader>
                <div className="skill-detail-head">
                  <div className={`skill-tile lg ${tileClass(confirmName)}`} aria-hidden>
                    {confirmName.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>{t('dialog.title', { name: confirmName })}</DialogTitle>
                  </div>
                </div>
              </DialogHeader>
              <DialogDescription className="skill-detail-desc">
                {confirmTarget.kind === 'preset'
                  ? confirmTarget.preset.description
                  : confirmTarget.manifest.description || t('card.noDescription')}
              </DialogDescription>
              <div className="skill-detail-meta">
                <div className="skill-detail-row">
                  <span className="k">{t('dialog.permissions')}</span>
                  <span className="v plugin-perm-row"><PermissionChips permissions={confirmPermissions} /></span>
                </div>
                {confirmTools.length > 0 && (
                  <div className="skill-detail-row">
                    <span className="k">{t('dialog.tools')}</span>
                    <span className="v plugin-tools">{confirmTools.map((n) => <code key={n}>{n}</code>)}</span>
                  </div>
                )}
                <div className="skill-detail-row">
                  <span className="k">{t('dialog.effect')}</span>
                  <span className="v">{t('dialog.effectDesc')}</span>
                </div>
              </div>
              <div className="skill-detail-actions">
                <button className="btn ghost sm" onClick={() => setConfirmTarget(null)}>
                  {t('dialog.cancel')}
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    if (confirmTarget.kind === 'preset') {
                      doInstall(confirmTarget.preset.installPath, confirmTarget.preset.name)
                    } else {
                      doInstall(confirmTarget.path, confirmName || confirmTarget.path)
                    }
                  }}
                >
                  {t('dialog.confirmInstall')}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
