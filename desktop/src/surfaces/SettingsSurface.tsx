import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Palette, SlidersHorizontal, Plug, Cpu, LifeBuoy, FolderOpen, type LucideIcon } from 'lucide-react'
import { useUiDispatch, useUiState } from '../state/store'
import { useHealth } from '../state/queries'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { loadFontWeightPref, setFontWeightPref, type FontWeightPref } from '../lib/font-weight'
import { loadFontFamilyPref, setFontFamilyPref, type FontFamilyPref } from '../lib/font-family'
import { loadGlassConfig, saveGlassConfig, type GlassConfig } from '../lib/glass-custom'
import { loadUiDensity, saveUiDensity, applyUiDensity, type UiDensity } from '../lib/ui-density'
import { useEnabledTabs, ALL_TABS } from '../lib/review-tabs'
import { useGlassMode } from '../lib/glass'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { AutonomyControl } from '../components/AutonomyControl'
import { GlassCustomPanel } from '../components/GlassCustomPanel'
import { FontSettingsPanel } from '../components/FontSettingsPanel'
import { coerceLevel, type AutonomyLevel } from '../lib/autonomy'
import { loadDefaultAutonomy, saveDefaultAutonomy, loadNotifPref, saveNotifPref, type ToolDensity, type NotifPref } from '../lib/persist'
import { ProviderSettings } from '../components/ProviderSettings'
import { RoutingSettings } from '../components/RoutingSettings'
import { McpSettingsManager } from '../components/McpSettings'
import { StorageLocationPanel } from '../components/StorageLocationPanel'
import { getStorageReport, cleanupStorage, getEditorConfig, setEditorConfig, getShellConfig, setShellConfig, getEnvironment, getCheckpointConfig, setCheckpointConfig, getComputerUseStatus, revokeComputerUseApp, getPermissionDirs, setPermissionDirs, deactivateLicense, type PermissionDirs, type ComputerUseStatus, type StorageReport, type EditorConfig, type EditorPlatform, type EditorEol } from '../runtime/client'
import { useProLicense } from '../lib/use-activation-gate'
import { ProUpgradeDialog } from '../components/ActivationScreen'
import { pickFolder } from '../lib/dialog'
import { openRivetHome, openEula } from '../lib/open-external'
import { getVersion } from '@tauri-apps/api/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import type { EnvironmentInfo } from '../runtime/types'
import { useWallpaper, type WallpaperFit } from '../components/WallpaperLayer'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
type SettingsCat = 'appearance' | 'behavior' | 'integrations' | 'system' | 'help'

const SETTINGS_CATS: { id: SettingsCat; icon: LucideIcon }[] = [
  { id: 'appearance', icon: Palette },
  { id: 'behavior', icon: SlidersHorizontal },
  { id: 'integrations', icon: Plug },
  { id: 'system', icon: Cpu },
  { id: 'help', icon: LifeBuoy },
]



export function SettingsSurface() {
  const { t } = useTranslation('settings')

  const THEME_LABEL: Record<ThemePref, string> = {
    system: t('theme.system'),
    light: t('theme.light'),
    dark: t('theme.dark'),
    nebula: t('theme.nebula'),
    sakura: t('theme.sakura'),
    cyberpunk: t('theme.cyberpunk'),
    cupertino: t('theme.cupertino'),
    'light-classic': t('theme.light-classic'),
    'codex-dark': t('theme.codex-dark'),
    'codex-light': t('theme.codex-light'),
  }
  const DENSITY_LABEL: Record<ToolDensity, string> = {
    compact: t('densityCompact'),
    balanced: t('densityBalanced'),
    detailed: t('densityDetailed'),
  }
  const NOTIF_LABEL: Record<NotifPref, string> = {
    never: t('notifNever'),
    background: t('notifBackground'),
    always: t('notifAlways'),
  }
  const FONT_WEIGHT_LABEL: Record<FontWeightPref, string> = {
    normal: t('fontWeight.normal'),
    medium: t('fontWeight.medium'),
    bold: t('fontWeight.bold'),
  }

  const [activeCat, setActiveCat] = useState<SettingsCat>('appearance')
  const health = useHealth()
  const dispatch = useUiDispatch()
  const ui = useUiState()
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [notifPref, setNotifPref] = useState<NotifPref>(() => loadNotifPref())
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())
  const [fontWeight, setFontWeight] = useState<FontWeightPref>(() => loadFontWeightPref())
  const [fontFamily, setFontFamily] = useState<FontFamilyPref>(() => loadFontFamilyPref())
  const [glassConfig, setGlassConfig] = useState<GlassConfig>(() => loadGlassConfig())
  const [uiDensity, setUiDensity] = useState<UiDensity>(() => loadUiDensity())
  const [enabledTabs, setEnabledTabs] = useEnabledTabs()

  const pick = (t: ThemePref) => {
    setTheme(t)
    setThemePref(t)
  }

  const pickFontWeight = (w: FontWeightPref) => {
    setFontWeight(w)
    setFontWeightPref(w)
  }

  const pickFontFamily = (f: FontFamilyPref) => {
    setFontFamily(f)
    setFontFamilyPref(f)
  }

  const pickUiDensity = (density: UiDensity) => {
    setUiDensity(density)
    saveUiDensity(density)
    applyUiDensity(density)
  }

  const updateGlass = (updates: Partial<GlassConfig>) => {
    const next = { ...glassConfig, ...updates }
    setGlassConfig(next)
    saveGlassConfig(next)
  }

  const pickAutonomy = (lvl: AutonomyLevel) => {
    setAutonomy(lvl)
    saveDefaultAutonomy(lvl)
  }

  const pickDensity = (d: ToolDensity) => {
    dispatch({ type: 'setToolDensity', density: d })
  }

  const pickNotif = (n: NotifPref) => {
    setNotifPref(n)
    saveNotifPref(n)
  }

  return (
    <div className="settings-dual">
      {/* Left: category nav */}
      <nav className="settings-nav">
        {SETTINGS_CATS.map((c) => (
          <button
            key={c.id}
            className={`settings-nav-item ${activeCat === c.id ? 'active' : ''}`}
            onClick={() => setActiveCat(c.id)}
          >
            <c.icon size={16} strokeWidth={1.7} />
            <span>{t(`cat.${c.id}`)}</span>
          </button>
        ))}
      </nav>

      {/* Right: content */}
      <div className="settings-content">
        {activeCat === 'appearance' && (
          <>
            <section className="settings-group">
              <h4>{t('themeLabel')}</h4>
              <Select value={theme} onValueChange={(v) => pick(v as ThemePref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('themePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino', 'light-classic', 'codex-dark', 'codex-light'] as ThemePref[]).map((t) => (
                    <SelectItem key={t} value={t}>{THEME_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
            <section className="settings-group">
              <h4>{t('fontWeightLabel')}</h4>
              <Select value={fontWeight} onValueChange={(v) => pickFontWeight(v as FontWeightPref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('fontWeightPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['normal', 'medium', 'bold'] as FontWeightPref[]).map((w) => (
                    <SelectItem key={w} value={w}>{FONT_WEIGHT_LABEL[w]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">{t('fontWeightHint')}</div>
            </section>
            <FontSettingsPanel value={fontFamily} onChange={pickFontFamily} />
            <section className="settings-group">
              <h4>{t('uiDensity')}</h4>
              <Select value={uiDensity} onValueChange={(v) => pickUiDensity(v as UiDensity)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('uiDensityPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">{t('uiDensityCompact')}</SelectItem>
                  <SelectItem value="cozy">{t('uiDensityCozy')}</SelectItem>
                  <SelectItem value="spacious">{t('uiDensitySpacious')}</SelectItem>
                </SelectContent>
              </Select>
              <div className="meta">{t('uiDensityHint')}</div>
            </section>
            <LanguageSection />
            <WallpaperSection glassConfig={glassConfig} updateGlass={updateGlass} />
          </>
        )}
        {activeCat === 'behavior' && (
          <>
            <section className="settings-group">
              <h4>{t('autonomy')}</h4>
              <AutonomyControl value={autonomy} onChange={pickAutonomy} />
              <div className="meta">{t('autonomyHint')}</div>
            </section>
            <PermissionDirsSection />
            <CheckpointSection />
            <section className="settings-group">
              <h4>{t('toolDensity')}</h4>
              <Select value={ui.toolDensity} onValueChange={(v) => pickDensity(v as ToolDensity)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('densityPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['compact', 'balanced', 'detailed'] as ToolDensity[]).map((d) => (
                    <SelectItem key={d} value={d}>{DENSITY_LABEL[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">{t('toolDensityHint')}</div>
            </section>
            <section className="settings-group">
              <h4>{t('notifications')}</h4>
              <Select value={notifPref} onValueChange={(v) => pickNotif(v as NotifPref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('notifPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['never', 'background', 'always'] as NotifPref[]).map((n) => (
                    <SelectItem key={n} value={n}>{NOTIF_LABEL[n]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">{t('notifHint')}</div>
            </section>
            <section className="settings-group">
              <h4>{t('reviewTabs.title')}</h4>
              <div className="flex flex-col gap-2 mt-2">
                {ALL_TABS.map((tab) => {
                  const isChecked = enabledTabs.includes(tab.id)
                  return (
                    <label key={tab.id} className="flex items-center gap-2 text-xs text-text cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isChecked && enabledTabs.length === 1} // Prevent disabling all tabs
                        onChange={(e) => {
                          if (e.target.checked) {
                            setEnabledTabs([...enabledTabs, tab.id])
                          } else {
                            setEnabledTabs(enabledTabs.filter((id) => id !== tab.id))
                          }
                        }}
                        className="rounded border-border text-accent focus:ring-accent h-3.5 w-3.5"
                      />
                      <span className="font-mono text-muted shrink-0">{tab.glyph}</span>
                      <span>{tab.label}</span>
                    </label>
                  )
                })}
              </div>
              <div className="meta mt-1.5">{t('reviewTabs.hint')}</div>
            </section>
          </>
        )}
        {activeCat === 'integrations' && (
          <div className="integration-stack">
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>{t('provider')}</h4>
                <p className="meta">{t('providerDesc')}</p>
              </div>
              <ProviderSettings />
            </section>
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>{t('routingCardTitle')}</h4>
                <p className="meta">{t('routingCardDesc')}</p>
              </div>
              <RoutingSettings />
            </section>
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>{t('mcpCardTitle')}</h4>
                <p className="meta">{t('mcpCardDesc')}</p>
              </div>
              <McpSettingsManager />
            </section>
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>{t('computerUse.title')}</h4>
                <p className="meta">{t('computerUse.desc')}</p>
              </div>
              <ComputerUseSettingsManager />
            </section>
          </div>
        )}
        {activeCat === 'system' && (
          <div className="system-stack">
            <section className="system-card">
              <div className="system-card-header">
                <h4>{t('runtime')}</h4>
                <p className="meta">{t('runtimeDesc')}</p>
              </div>
              {health.isError ? (
                <div className="meta warn">{t('sidecarOffline')}</div>
              ) : (
                <dl className="kv">
                  <div><dt>{t('runtimeVersion')}</dt><dd>{health.data?.version ?? '—'}</dd></div>
                  <div><dt>{t('runtimeSessions')}</dt><dd>{health.data?.sessionCount ?? 0}</dd></div>
                  <div><dt>{t('runtimeRunning')}</dt><dd>{health.data?.runningCount ?? 0}</dd></div>
                  <div>
                    <dt>{t('runtimeUptime')}</dt>
                    <dd>{health.data ? `${Math.round(health.data.uptimeMs / 1000)}s` : '—'}</dd>
                  </div>
                </dl>
              )}
            </section>
            <AutostartSection />
            <PlatformSection />
            <ShellSection />
            <GitPathSection />
            <StorageLocationSection />
            <StorageSection />
            <UpdaterSection />
            <AboutSection />
          </div>
        )}
        {activeCat === 'help' && <HelpSection onNavigate={setActiveCat} />}
      </div>
    </div>
  )
}

type HelpTab = 'start' | 'commands' | 'config' | 'shortcuts'
const HELP_TABS: HelpTab[] = ['start', 'commands', 'config', 'shortcuts']

/** Ids into the settings:help.cmd.* i18n subtree (each has .cmd and .desc keys). */
const HELP_COMMAND_IDS = ['team', 'teamMax', 'council', 'review', 'reviewMax', 'plan'] as const

/**
 * In-app user guide. Organised into topic tabs so first-time users can scan
 * what the help page covers instead of facing one long stacked list.
 */
function HelpSection({ onNavigate }: { onNavigate: (cat: SettingsCat) => void }) {
  const { t } = useTranslation('settings')
  const [tab, setTab] = useState<HelpTab>('start')
  const richTags = { code: <code />, strong: <strong />, kbd: <kbd /> }

  return (
    <Tabs value={tab} onValueChange={(v) => { if (v) setTab(v as HelpTab) }} className="help-tabs">
      <TabsList variant="line" className="help-tabs-list">
        {HELP_TABS.map((id) => (
          <TabsTrigger key={id} value={id} className="help-tab-trigger">
            {t(`help.tab.${id}`)}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="start">
        <div className="help-card">
          <h4>{t('help.startTitle')}</h4>
          <ol className="help-steps">
            <li>{t('help.startStep1')}</li>
            <li>{t('help.startStep2')}</li>
            <li><Trans t={t} i18nKey="help.startStep3" components={richTags} /></li>
          </ol>
          <button className="btn" onClick={() => onNavigate('integrations')}>{t('help.startCta')}</button>
        </div>
      </TabsContent>

      <TabsContent value="commands">
        <div className="help-card">
          <h4>{t('help.commandsTitle')}</h4>
          <p className="help-lead">
            <Trans t={t} i18nKey="help.commandsLead1" components={richTags} />
            <code>{'<…>'}</code>
            <Trans t={t} i18nKey="help.commandsLead2" components={richTags} />
          </p>
          <div className="help-cmds-grid">
            {HELP_COMMAND_IDS.map((id) => (
              <div key={id} className="help-cmd-card">
                <code>{t(`help.cmd.${id}.cmd`)}</code>
                <p><Trans t={t} i18nKey={`help.cmd.${id}.desc`} components={richTags} /></p>
              </div>
            ))}
          </div>
          <div className="help-hint">
            <Trans t={t} i18nKey="help.commandsHint" components={richTags} />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="config">
        <div className="help-cards-stack">
          <div className="help-card">
            <h4>{t('help.providerKeyTitle')}</h4>
            <p className="help-lead">
              <Trans t={t} i18nKey="help.providerKeyDesc" components={richTags} />
            </p>
            <button className="btn" onClick={() => onNavigate('integrations')}>{t('help.ctaIntegrations')}</button>
          </div>

          <div className="help-card">
            <h4>{t('help.routingTitle')}</h4>
            <p className="help-lead">
              <Trans t={t} i18nKey="help.routingDesc1" components={richTags} />
            </p>
            <p className="help-lead">
              <Trans t={t} i18nKey="help.routingDesc2" components={richTags} />
            </p>
            <button className="btn" onClick={() => onNavigate('integrations')}>{t('help.ctaRouting')}</button>
          </div>

          <div className="help-card">
            <h4>{t('help.autonomyTitle')}</h4>
            <p className="help-lead">
              {t('help.autonomyDesc')}
            </p>
            <button className="btn" onClick={() => onNavigate('behavior')}>{t('help.ctaBehavior')}</button>
          </div>

          <div className="help-card">
            <h4>{t('help.filesTitle')}</h4>
            <dl className="help-kv">
              <div><dt>{t('help.filesMainConfig')}</dt><dd><code>~/.rivet/config.json</code></dd></div>
              <div><dt>{t('help.filesProjectOverride')}</dt><dd><Trans t={t} i18nKey="help.filesProjectOverrideValue" components={richTags} /></dd></div>
              <div><dt>{t('help.filesSessionLogs')}</dt><dd><code>{t('help.filesSessionLogsValue')}</code></dd></div>
              <div><dt>{t('help.filesConfigExample')}</dt><dd><Trans t={t} i18nKey="help.filesConfigExampleValue" components={richTags} /></dd></div>
            </dl>
            <p className="help-lead">
              {t('help.filesNote')}
            </p>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="shortcuts">
        <div className="help-card">
          <h4>{t('help.shortcutsTitle')}</h4>
          <dl className="help-shortcuts">
            <div><dt><kbd>⌘K</kbd></dt><dd>{t('help.shortcutPalette')}</dd></div>
            <div><dt><kbd>⌘N</kbd></dt><dd>{t('help.shortcutNewThread')}</dd></div>
            <div><dt><kbd>⌘B</kbd></dt><dd>{t('help.shortcutSidebar')}</dd></div>
            <div><dt><kbd>⌘⇧B</kbd></dt><dd>{t('help.shortcutReview')}</dd></div>
            <div><dt><kbd>/</kbd></dt><dd>{t('help.shortcutSlash')}</dd></div>
          </dl>
        </div>
      </TabsContent>
    </Tabs>
  )
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * 存储管理 — 显示会话文件占用，并允许手动清理「归档会话」。归档会话的事件日志
 * 会随历史无限增长，这里给用户一个可见、可控的回收入口。清理基于 stat（仅读元
 * 数据，不读文件内容），对硬盘几乎无压力;删除不可逆,仅作用于已归档且空闲的会话。
 */
/**
 * Target-OS conventions: new-file line endings + the OS the system prompt tells
 * the model it's on. Writes to the user global config; takes effect on the next
 * sidecar start (the target is resolved once at startup). Per-project overrides
 * still go through the project's .rivet-config.json `editor` block.
 */
/** W5 — launch-at-login toggle (tauri-plugin-autostart). Windows: HKCU Run key;
    macOS: LaunchAgent. Hidden entirely in browser-dev (no Tauri runtime). */
function AutostartSection() {
  const { t } = useTranslation('settings')
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    void import('@tauri-apps/plugin-autostart')
      .then((m) => m.isEnabled())
      .then(setEnabled)
      .catch(() => setEnabled(null))
  }, [isTauri])

  const toggle = useCallback(async () => {
    if (enabled === null || busy) return
    setBusy(true)
    try {
      const m = await import('@tauri-apps/plugin-autostart')
      if (enabled) await m.disable()
      else await m.enable()
      setEnabled(await m.isEnabled())
    } catch (err) {
      toast.error(t('autostart.failed', { error: (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }, [enabled, busy, t])

  if (!isTauri || enabled === null) return null

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('autostart.title')}</h4>
        <p className="meta">{t('autostart.desc')}</p>
      </div>
      <label className="flex items-center gap-2 text-xs text-text" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={() => void toggle()}
        />
        <span>{enabled ? t('autostart.enabled') : t('autostart.disabled')}</span>
      </label>
    </section>
  )
}

/** C3 — Auto 模式检查点间隔。权限模式（Manual/Auto/YOLO）通过 AutonomyControl 切换。 */
function CheckpointSection() {
  const { t } = useTranslation('settings')
  const [cfg, setCfg] = useState<{ checkpointEveryTurns: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [customInterval, setCustomInterval] = useState('')

  useEffect(() => {
    void getCheckpointConfig()
      .then((c) => setCfg({ checkpointEveryTurns: c.checkpointEveryTurns }))
      .catch(() => setCfg(null))
  }, [])

  const update = useCallback(async (patch: { checkpointEveryTurns?: number }) => {
    setMsg(null)
    try {
      const saved = await setCheckpointConfig(patch)
      setCfg({ checkpointEveryTurns: saved.checkpointEveryTurns })
      setMsg(t('checkpoint.saved'))
    } catch (err) {
      setMsg(t('checkpoint.saveFailed', { error: (err as Error).message }))
    }
  }, [t])

  if (cfg === null) return null

  const presetIntervals = [20, 25, 30]
  const isPreset = presetIntervals.includes(cfg.checkpointEveryTurns)

  const applyCustomInterval = () => {
    const v = Number(customInterval)
    if (!Number.isInteger(v) || v < 0) {
      setMsg(t('checkpoint.invalidInterval'))
      return
    }
    setCustomInterval('')
    void update({ checkpointEveryTurns: v })
  }

  return (
    <section className="settings-group">
      <h4>{t('checkpoint.title')}</h4>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <Select
          value={isPreset ? String(cfg.checkpointEveryTurns) : 'custom'}
          onValueChange={(v) => { if (v !== 'custom') void update({ checkpointEveryTurns: Number(v) }) }}
        >
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="20">{t('checkpoint.every', { n: 20 })}</SelectItem>
            <SelectItem value="25">{t('checkpoint.every25')}</SelectItem>
            <SelectItem value="30">{t('checkpoint.every', { n: 30 })}</SelectItem>
            {!isPreset && (
              <SelectItem value="custom">
                {cfg.checkpointEveryTurns === 0 ? t('checkpoint.off') : t('checkpoint.everyCustom', { n: cfg.checkpointEveryTurns })}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <input
          className="settings-input"
          style={{ width: 96 }}
          inputMode="numeric"
          placeholder={t('checkpoint.customPlaceholder')}
          value={customInterval}
          onChange={(e) => setCustomInterval(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyCustomInterval() }}
        />
        <button type="button" className="btn-sm" onClick={applyCustomInterval} disabled={!customInterval.trim()}>
          {t('checkpoint.apply')}
        </button>
      </div>
      <div className="meta">
        {t('checkpoint.hint')}
      </div>
      {msg && <div className="meta">{msg}</div>}
    </section>
  )
}

/**
 * Codex-style standing directory grants (agent.permissions.additional*Dirs):
 * hand whole folders (or a drive root) to the agent without per-file approval
 * prompts. Backed by GET/PUT /config/permission-dirs; additions apply to the
 * running sidecar immediately, removals need a sidecar restart.
 */
function PermissionDirsSection() {
  const { t } = useTranslation('settings')
  const [dirs, setDirs] = useState<PermissionDirs | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [readInput, setReadInput] = useState('')
  const [writeInput, setWriteInput] = useState('')

  useEffect(() => {
    void getPermissionDirs()
      .then((d) => setDirs(d))
      .catch(() => setLoadFailed(true))
  }, [])

  const save = useCallback(async (readPaths: string[], writePaths: string[]) => {
    setMsg(null)
    try {
      const saved = await setPermissionDirs({
        additionalReadDirs: readPaths,
        additionalWriteDirs: writePaths,
      })
      setDirs({ readDirs: saved.readDirs, writeDirs: saved.writeDirs })
      setMsg(saved.restartRequired ? t('permissionDirs.savedRestart') : t('permissionDirs.savedApplied'))
    } catch (err) {
      setMsg(t('permissionDirs.saveFailed', { error: (err as Error).message }))
    }
  }, [t])

  if (loadFailed || dirs === null) return null

  const readPaths = dirs.readDirs.map((d) => d.path)
  const writePaths = dirs.writeDirs.map((d) => d.path)

  const addDir = (mode: 'read' | 'write', raw: string) => {
    const path = raw.trim()
    if (!path) return
    if (mode === 'read') {
      if (readPaths.includes(path)) return
      setReadInput('')
      void save([...readPaths, path], writePaths)
    } else {
      if (writePaths.includes(path)) return
      setWriteInput('')
      void save(readPaths, [...writePaths, path])
    }
  }

  const removeDir = (mode: 'read' | 'write', path: string) => {
    if (mode === 'read') void save(readPaths.filter((p) => p !== path), writePaths)
    else void save(readPaths, writePaths.filter((p) => p !== path))
  }

  const pickAndAdd = async (mode: 'read' | 'write') => {
    const folder = await pickFolder()
    if (folder) addDir(mode, folder)
  }

  const renderList = (mode: 'read' | 'write', entries: { path: string; exists: boolean }[]) => (
    entries.length === 0 ? (
      <div className="meta mt-1">{t('permissionDirs.empty')}</div>
    ) : (
      <ul className="mt-1 flex flex-col gap-1 list-none p-0 m-0">
        {entries.map((d) => (
          <li key={d.path} className="flex items-center gap-2 text-sm">
            <span className="font-mono break-all">{d.path}</span>
            {!d.exists && <span className="badge warn shrink-0">{t('permissionDirs.missing')}</span>}
            <button type="button" className="btn ghost sm ml-auto shrink-0" onClick={() => removeDir(mode, d.path)}>
              {t('permissionDirs.remove')}
            </button>
          </li>
        ))}
      </ul>
    )
  )

  const renderAddRow = (
    mode: 'read' | 'write',
    input: string,
    setInput: (v: string) => void,
  ) => (
    <div className="flex items-center gap-2 mt-1.5" style={{ flexWrap: 'wrap' }}>
      <button type="button" className="btn-sm" onClick={() => void pickAndAdd(mode)}>
        {t('permissionDirs.addFolder')}
      </button>
      <input
        className="settings-input flex-1"
        style={{ minWidth: 220 }}
        placeholder={t('permissionDirs.manualPlaceholder')}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') addDir(mode, input) }}
      />
      <button type="button" className="btn-sm" onClick={() => addDir(mode, input)} disabled={!input.trim()}>
        {t('permissionDirs.add')}
      </button>
    </div>
  )

  return (
    <section className="settings-group">
      <h4>{t('permissionDirs.title')}</h4>
      <div className="meta">{t('permissionDirs.desc')}</div>
      <div className="mt-2">
        <h5 className="text-sm font-medium m-0">{t('permissionDirs.readTitle')}</h5>
        <div className="meta">{t('permissionDirs.readDesc')}</div>
        {renderList('read', dirs.readDirs)}
        {renderAddRow('read', readInput, setReadInput)}
      </div>
      <div className="mt-3">
        <h5 className="text-sm font-medium m-0">{t('permissionDirs.writeTitle')}</h5>
        <div className="meta">{t('permissionDirs.writeDesc')}</div>
        {renderList('write', dirs.writeDirs)}
        {renderAddRow('write', writeInput, setWriteInput)}
      </div>
      {msg && <div className="meta mt-1.5">{msg}</div>}
    </section>
  )
}

function PlatformSection() {
  const { t } = useTranslation('settings')
  const [cfg, setCfg] = useState<EditorConfig | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void getEditorConfig().then(setCfg).catch(() => setCfg(null))
  }, [])

  const update = useCallback(async (patch: { platform?: EditorPlatform; eol?: EditorEol }) => {
    setMsg(null)
    try {
      const next = await setEditorConfig(patch)
      setCfg({ platform: next.platform, eol: next.eol })
      setMsg(t('platform.saved'))
    } catch (err) {
      setMsg(t('platform.saveFailed', { error: (err as Error).message }))
    }
  }, [t])

  if (!cfg) return null

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('platform.title')}</h4>
        <p className="meta"><Trans t={t} i18nKey="platform.desc" components={{ code: <code /> }} /></p>
      </div>
      <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
        <label className="flex items-center gap-2 text-xs text-text">
          <span className="text-muted">{t('platform.targetPlatform')}</span>
          <Select value={cfg.platform} onValueChange={(v) => void update({ platform: v as EditorPlatform })}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('platform.auto')}</SelectItem>
              <SelectItem value="windows">Windows (CRLF)</SelectItem>
              <SelectItem value="macos">macOS (LF)</SelectItem>
              <SelectItem value="linux">Linux (LF)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-2 text-xs text-text">
          <span className="text-muted">{t('platform.eol')}</span>
          <Select value={cfg.eol} onValueChange={(v) => void update({ eol: v as EditorEol })}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('platform.eolAuto')}</SelectItem>
              <SelectItem value="lf">LF</SelectItem>
              <SelectItem value="crlf">CRLF</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}
      <div className="meta" style={{ marginTop: 6 }}>
        <Trans t={t} i18nKey="platform.footer" components={{ code: <code /> }} />
      </div>
    </section>
  )
}

function ShellSection() {
  const { t } = useTranslation('settings')
  const [env, setEnv] = useState<EnvironmentInfo | null>(null)
  const [path, setPath] = useState('')
  const [saved, setSaved] = useState('')
  const [exists, setExists] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([getEnvironment(), getShellConfig()])
      setEnv(e)
      setPath(s.gitBashPath)
      setSaved(s.gitBashPath)
      setExists(s.exists)
    } catch {
      setEnv(null)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const next = await setShellConfig({ gitBashPath: path })
      setSaved(next.gitBashPath)
      setExists(next.exists)
      if (next.gitBashPath && next.exists === false) {
        setMsg(t('shell.savedMissing'))
      } else if (next.gitBashPath) {
        setMsg(t('shell.saved'))
      } else {
        setMsg(t('shell.cleared'))
      }
      void getEnvironment().then(setEnv).catch(() => {})
    } catch (err) {
      setMsg(t('shell.saveFailed', { error: (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }, [path, t])

  // Git Bash override only affects command execution on Windows. Hide the whole
  // card elsewhere to avoid confusing macOS/Linux users. Render nothing until
  // the environment probe resolves so we don't flash then vanish.
  if (!env) return null
  if (env.platform !== 'win32') return null

  const shell = env.shell
  const usingBash = shell?.kind === 'bash'
  const statusText = shell
    ? usingBash
      ? t('shell.statusUsing', { kind: shell.kind })
      : t('shell.statusFallback', { kind: shell.kind })
    : t('shell.statusUnknown')

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('shell.title')}</h4>
        <p className="meta">
          <Trans t={t} i18nKey="shell.desc" components={{ code: <code /> }} />
        </p>
      </div>
      <div className={`meta ${usingBash ? '' : 'warn'}`} style={{ marginBottom: 8 }}>
        {t('shell.current')}{statusText}
        {shell?.gitBashAvailable === false && t('shell.noBash')}
      </div>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\\Program Files\\Git\\bin\\bash.exe"
          spellCheck={false}
          style={{ minWidth: 340, flex: 1, fontFamily: 'var(--font-mono, monospace)' }}
        />
        <Button onClick={() => void save()} disabled={busy || path.trim() === saved.trim()}>
          {busy ? t('shell.saving') : t('shell.save')}
        </Button>
        {saved && (
          <Button variant="outline" onClick={() => { setPath(''); }} disabled={busy}>
            {t('shell.clear')}
          </Button>
        )}
      </div>
      {saved && exists === false && (
        <div className="meta warn" style={{ marginTop: 6 }}>{t('shell.savedPathMissing')}<code>{saved}</code></div>
      )}
      {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  )
}

function GitPathSection() {
  const { t } = useTranslation('settings')
  const [env, setEnv] = useState<EnvironmentInfo | null>(null)
  const [path, setPath] = useState('')
  const [saved, setSaved] = useState('')
  const [exists, setExists] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([getEnvironment(), getShellConfig()])
      setEnv(e)
      setPath(s.gitPath)
      setSaved(s.gitPath)
      setExists(s.gitExists)
    } catch {
      setEnv(null)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const next = await setShellConfig({ gitPath: path })
      setSaved(next.gitPath)
      setExists(next.gitExists)
      if (next.gitPath && next.gitExists === false) {
        setMsg(t('gitPath.savedMissing'))
      } else if (next.gitPath) {
        setMsg(t('gitPath.saved'))
      } else {
        setMsg(t('gitPath.cleared'))
      }
      void getEnvironment().then(setEnv).catch(() => {})
    } catch (err) {
      setMsg(t('gitPath.saveFailed', { error: (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }, [path, t])

  // Render nothing until the environment probe resolves.
  if (!env) return null

  const placeholder = env.platform === 'win32' ? t('gitPath.placeholderWin') : t('gitPath.placeholderUnix')
  const gitAvailable = env.git.available

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('gitPath.title')}</h4>
        <p className="meta">
          <Trans t={t} i18nKey="gitPath.desc" components={{ code: <code /> }} />
        </p>
      </div>
      <div className={`meta ${gitAvailable ? '' : 'warn'}`} style={{ marginBottom: 8 }}>
        {gitAvailable
          ? t('gitPath.statusAvailable', { version: env.git.version ? ` (${env.git.version})` : '' })
          : t('gitPath.statusMissing')}
      </div>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          style={{ minWidth: 340, flex: 1, fontFamily: 'var(--font-mono, monospace)' }}
        />
        <Button onClick={() => void save()} disabled={busy || path.trim() === saved.trim()}>
          {busy ? t('gitPath.saving') : t('gitPath.save')}
        </Button>
        {saved && (
          <Button variant="outline" onClick={() => { setPath(''); }} disabled={busy}>
            {t('gitPath.clear')}
          </Button>
        )}
      </div>
      {saved && exists === false && (
        <div className="meta warn" style={{ marginTop: 6 }}>{t('gitPath.savedPathMissing')}<code>{saved}</code></div>
      )}
      {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  )
}

function StorageLocationSection() {
  const { t } = useTranslation('settings')
  const [revealing, setRevealing] = useState(false)

  const handleApplied = async (requiresRestart: boolean) => {
    if (requiresRestart) {
      toast.success(t('storageLocation.savedRestart'))
      try {
        await relaunch()
      } catch {
        window.location.reload()
      }
    } else {
      toast.success(t('storageLocation.saved'))
    }
  }

  const handleOpenDataFolder = async () => {
    setRevealing(true)
    try {
      await openRivetHome()
    } catch (err) {
      toast.error(t('storageLocation.openFailed', { error: (err as Error).message }))
    } finally {
      setRevealing(false)
    }
  }

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('storageLocation.title')}</h4>
        <p className="meta">{t('storageLocation.desc')}</p>
      </div>
      <div style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => void handleOpenDataFolder()} disabled={revealing}>
          <FolderOpen size={14} /> {revealing ? t('storageLocation.opening') : t('storageLocation.openFolder')}
        </button>
        <span className="meta" style={{ marginLeft: 8, fontSize: 12 }}>
          {t('storageLocation.openHint')}
        </span>
      </div>
      <StorageLocationPanel onApplied={handleApplied} />
    </section>
  )
}

function StorageSection() {
  const { t } = useTranslation('settings')
  const [report, setReport] = useState<StorageReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [days, setDays] = useState(30)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await getStorageReport())
    } catch {
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const runCleanup = useCallback(async (opts: { ids?: string[]; olderThanDays?: number }, confirmText: string) => {
    if (!window.confirm(confirmText)) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await cleanupStorage(opts)
      setMsg(t('storage.cleaned', { n: res.deleted, bytes: formatBytes(res.freedBytes) }))
      await refresh()
    } catch (err) {
      setMsg(t('storage.cleanFailed', { error: (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const archived = report?.archived ?? []

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('storage.title')}</h4>
        <p className="meta">{t('storage.desc')}</p>
      </div>
      {loading && !report ? (
        <div className="meta">{t('storage.counting')}</div>
      ) : !report ? (
        <div className="meta warn">{t('storage.unavailable')}</div>
      ) : (
        <>
          <dl className="kv">
            <div><dt>{t('storage.totalUsage')}</dt><dd>{formatBytes(report.totalBytes)}</dd></div>
            <div><dt>{t('storage.sessionCount')}</dt><dd>{report.sessionCount}</dd></div>
            <div><dt>{t('storage.archivedCount')}</dt><dd>{t('storage.archivedValue', { n: report.archivedCount, bytes: formatBytes(report.archivedBytes) })}</dd></div>
          </dl>

          <div className="meta" style={{ marginTop: 8 }}>
            <Trans t={t} i18nKey="storage.note" components={{ strong: <strong /> }} />
          </div>

          <div className="flex items-center gap-2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={busy || archived.length === 0}
              onClick={() => runCleanup(
                { olderThanDays: days },
                t('storage.cleanupConfirmDays', { days }),
              )}
            >
              {t('storage.cleanupPrefix')}
              <input
                type="number"
                min={0}
                value={days}
                onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))}
                onClick={(e) => e.stopPropagation()}
                style={{ width: 52, margin: '0 4px', textAlign: 'center' }}
              />
              {t('storage.cleanupSuffix')}
            </button>
            <button
              className="btn btn-danger"
              disabled={busy || archived.length === 0}
              onClick={() => runCleanup(
                {},
                t('storage.cleanupConfirmAll', { n: archived.length, bytes: formatBytes(report.archivedBytes) }),
              )}
            >
              {t('storage.cleanupAll', { n: archived.length })}
            </button>
            <button className="btn" disabled={loading || busy} onClick={() => void refresh()}>{t('storage.refresh')}</button>
          </div>

          {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}

          {archived.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="meta">{t('storage.archivedList')}</div>
              <div className="flex flex-col gap-1" style={{ marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
                {archived.map((s) => (
                  <div key={s.id} className="flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
                    <span className="text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || s.id}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="meta">{formatBytes(s.bytes)} · {new Date(s.updatedAt).toLocaleDateString()}</span>
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => runCleanup(
                          { ids: [s.id] },
                          t('storage.deleteConfirm', { title: s.title || s.id, bytes: formatBytes(s.bytes) }),
                        )}
                      >{t('storage.delete')}</button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <div style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => void openRivetHome()}>
          <FolderOpen size={14} /> {t('storage.openFolder')}
        </button>
        <span className="meta" style={{ marginLeft: 8, fontSize: 12 }}>
          {t('storage.openHint')}
        </span>
      </div>
    </section>
  )
}

function UpdaterSection() {
  const { t } = useTranslation('settings')
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [update, setUpdate] = useState<Update | null>(null)
  const [progress, setProgress] = useState<number | null>(null)

  const handleCheck = async () => {
    setChecking(true)
    setMessage(null)
    setUpdate(null)
    setProgress(null)
    try {
      const result = await check()
      if (result) {
        setUpdate(result)
        setMessage(t('updateAvailable', { version: result.version }))
      } else {
        setMessage(t('updateLatest'))
      }
    } catch (err) {
      setMessage(t('updateCheckFailed', { error: (err as Error).message }))
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    if (!update) return
    setInstalling(true)
    setProgress(0)
    setMessage(null)
    try {
      let total = 0
      let downloaded = 0
      // downloadAndInstall streams progress events; on completion resolves and
      // relaunch must run after the install finishes writing.
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
            // 进入"重启中"过渡态：installing=false + 完成提示，避免 relaunch 前
            // 盲等让用户以为卡住（与 UpdateBanner 一致）。
            setProgress(100)
            setInstalling(false)
            setMessage(t('updateInstallingComplete'))
            break
        }
      })
      await relaunch()
    } catch (err) {
      setMessage(t('updateInstallFailed', { error: (err as Error).message }))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('update')}</h4>
        <p className="meta">{t('updateDesc')}</p>
      </div>
      <button className="btn" onClick={handleCheck} disabled={checking || installing}>
        {checking ? t('updateChecking') : t('updateCheck')}
      </button>
      {update && (
        <div className="updater-actions">
          <div className="meta">{t('updateAvailableShort', { version: update.version })}</div>
          {update.body && <div className="meta">{update.body}</div>}
          <button className="btn" onClick={handleInstall} disabled={installing}>
            {installing ? (progress != null ? t('updateDownloading', { progress }) : t('updateInstalling')) : t('updateDownload')}
          </button>
        </div>
      )}
      {installing && progress != null && (
        <div className="updater-progress">
          <div className="updater-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      )}
      {message && <div className="meta">{message}</div>}
    </section>
  )
}

/** About / License: app version, Basic/Pro tier, license management, EULA access. */
function AboutSection() {
  const { t } = useTranslation('settings')
  const [version, setVersion] = useState<string | null>(null)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  // 双层模式：Basic 免许可证即用，Pro 许可证经 Rust 验签解锁高级功能。
  const { status, isPro, refresh } = useProLicense()

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null))
  }, [])

  const handleRemoveLicense = useCallback(() => {
    void deactivateLicense()
      .then(() => refresh())
      .catch(() => {})
  }, [refresh])

  const expiryLabel = (() => {
    if (!isPro) return null
    if (status?.licenseExpires == null) return t('about.proPerpetual')
    return new Date(status.licenseExpires).toLocaleDateString()
  })()

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>{t('about.title')}</h4>
        <p className="meta">{t('about.desc')}</p>
      </div>
      <dl className="kv">
        <div><dt>{t('about.version')}</dt><dd>{version ?? '—'}</dd></div>
        <div><dt>{t('about.license')}</dt><dd>{t('about.licenseValue')}</dd></div>
        <div>
          <dt>{t('about.tier')}</dt>
          <dd>
            {isPro ? t('about.tierPro') : t('about.tierBasic')}
            {status?.grace ? ` · ${t('about.proGrace')}` : ''}
          </dd>
        </div>
        {expiryLabel && <div><dt>{t('about.proExpiry')}</dt><dd>{expiryLabel}</dd></div>}
      </dl>
      {!isPro && <p className="meta">{t('about.proPitch')}</p>}
      <p className="meta">{t('about.boundary')}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!isPro && (
          <button className="btn" onClick={() => setUpgradeOpen(true)}>
            {t('about.upgradePro')}
          </button>
        )}
        {isPro && (
          <button className="btn" onClick={handleRemoveLicense}>
            {t('about.removeLicense')}
          </button>
        )}
        <button className="btn" onClick={() => { void openEula() }}>
          {t('about.viewEula')}
        </button>
      </div>
      <ProUpgradeDialog status={status} open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </section>
  )
}

/** Computer Use (macOS GUI automation): permission status + per-app grants. */
function ComputerUseSettingsManager() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStatus = useCallback(() => {
    setLoading(true)
    getComputerUseStatus()
      .then((s) => { setStatus(s); setError(null) })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  const handleRevoke = useCallback((app: string) => {
    revokeComputerUseApp(app)
      .then((r) => setStatus((prev) => (prev ? { ...prev, grants: r.grants } : prev)))
      .catch((err) => toast.error(t('computerUse.revokeFailed', { error: (err as Error).message })))
  }, [t])

  if (loading && !status) return <div className="meta">{t('computerUse.loading')}</div>
  if (error) return <div className="meta text-destructive">{error}</div>
  if (!status) return null

  if (!status.available) {
    if (status.proRequired) {
      return <div className="meta">{t('computerUse.proRequired')}</div>
    }
    return <div className="meta">{t('computerUse.unavailable')}</div>
  }

  const permBadge = (granted: boolean) => (
    <span className={`badge ${granted ? 'ok' : 'warn'}`}>
      {granted ? t('computerUse.permGranted') : t('computerUse.permMissing')}
    </span>
  )

  return (
    <div className="computer-use-settings flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h5 className="text-sm font-medium m-0">{t('computerUse.permissions')}</h5>
          <button className="btn ghost sm" onClick={fetchStatus}>{t('computerUse.refresh')}</button>
        </div>
        {status.permissions ? (
          <div className="flex items-center gap-4 mt-1.5 text-sm">
            <span className="flex items-center gap-1.5">{t('computerUse.permAccessibility')} {permBadge(status.permissions.accessibility)}</span>
            <span className="flex items-center gap-1.5">{t('computerUse.permScreenRecording')} {permBadge(status.permissions.screenRecording)}</span>
          </div>
        ) : (
          <div className="meta mt-1.5">{t('computerUse.permUnknown')}</div>
        )}
        {status.permissions && !(status.permissions.accessibility && status.permissions.screenRecording) && (
          <div className="meta mt-1">{status.permissions.detail}</div>
        )}
      </div>

      <div>
        <h5 className="text-sm font-medium m-0">{t('computerUse.grantsTitle')}</h5>
        {status.grants.length === 0 ? (
          <div className="meta mt-1.5">{t('computerUse.grantsEmpty')}</div>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1 list-none p-0 m-0">
            {status.grants.map((g) => (
              <li key={g.app} className="flex items-center gap-2 text-sm">
                <span className="font-mono">{g.app}</span>
                <span className="meta">{new Date(g.grantedAt).toLocaleString()}</span>
                <button className="btn ghost sm ml-auto" onClick={() => handleRevoke(g.app)}>
                  {t('computerUse.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Wallpaper & frosted glass settings section. */
function WallpaperSection({
  glassConfig,
  updateGlass,
}: {
  glassConfig: GlassConfig
  updateGlass: (updates: Partial<GlassConfig>) => void
}) {
  const { t } = useTranslation('settings')
  const { wallpaper, fit, pick, clear, changeFit } = useWallpaper()
  const [glassMode, setGlassMode] = useGlassMode()
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const FIT_LABEL: Record<WallpaperFit, string> = {
    cover: t('wallpaperFitCover'),
    contain: t('wallpaperFitContain'),
    center: t('wallpaperFitCenter'),
  }

  const handlePick = useCallback(
    async (f: File) => {
      setBusy(true)
      try {
        await pick(f)
      } finally {
        setBusy(false)
      }
    },
    [pick],
  )

  return (
    <section className="settings-group">
      <h4>{t('wallpaper')}</h4>
      <div className="wallpaper-row">
        <div
          className="wallpaper-preview"
          style={wallpaper ? { backgroundImage: `url("${wallpaper.url}")` } : undefined}
        >
          {!wallpaper && <span className="wallpaper-empty">{t('wallpaperEmpty')}</span>}
        </div>
        <div className="wallpaper-controls">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handlePick(f)
              e.target.value = ''
            }}
          />
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? t('wallpaperProcessing') : t('selectImage')}
          </button>
          {wallpaper && (
            <button className="btn btn-danger" onClick={clear}>
              {t('clearWallpaper')}
            </button>
          )}
          {wallpaper && (
            <div className="seg">
              {(['cover', 'contain', 'center'] as WallpaperFit[]).map((f) => (
                <button
                  key={f}
                  className={`seg-item ${fit === f ? 'active' : ''}`}
                  onClick={() => changeFit(f)}
                >
                  {FIT_LABEL[f]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="settings-field">
        <label className="field-check">
          <input
            type="checkbox"
            checked={glassMode}
            onChange={(e) => setGlassMode(e.target.checked)}
          />
          <span>{t('glassMode')}</span>
        </label>
      </div>

      {glassMode && <GlassCustomPanel config={glassConfig} onChange={updateGlass} />}

      <div className="meta" style={{ marginTop: '12px' }}>
        {t('wallpaperHint')}
      </div>
    </section>
  )
}

/** Language selector — switches i18next locale, persisted to localStorage. */
function LanguageSection() {
  const { t } = useTranslation('language')
  const { i18n } = useTranslation()
  const langs = ['zh-CN', 'en'] as const
  return (
    <section className="settings-group">
      <h4>{t('label')}</h4>
      <Select value={i18n.language} onValueChange={(v) => { if (v) i18n.changeLanguage(v) }}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder={t('label')} />
        </SelectTrigger>
        <SelectContent>
          {langs.map((l) => (
            <SelectItem key={l} value={l}>{t(l)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  )
}
