import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette, SlidersHorizontal, Plug, Cpu, LifeBuoy, type LucideIcon } from 'lucide-react'
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
import { McpSettings } from '../components/McpSettings'
import { StorageLocationPanel } from '../components/StorageLocationPanel'
import { getMcpStatus, getMcpPresets, addMcpServer, removeMcpServer, restartMcpServer, getStorageReport, cleanupStorage, getEditorConfig, setEditorConfig, getShellConfig, setShellConfig, getEnvironment, getCheckpointConfig, setCheckpointConfig, type StorageReport, type EditorConfig, type EditorPlatform, type EditorEol } from '../runtime/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import type { McpStatusResponse, McpServerConfig, McpPreset, EnvironmentInfo } from '../runtime/types'
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
    light: '默认亮色 (Default Light)',
    dark: t('theme.dark'),
    nebula: t('theme.nebula'),
    sakura: '樱花粉 (Sakura Pink)',
    cyberpunk: '赛博朋克 (Cyberpunk Neon)',
    cupertino: '苹果极简 (Cupertino Clean)',
    'light-classic': '经典亮色 (Classic Light)',
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
                  {(['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino', 'light-classic'] as ThemePref[]).map((t) => (
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
              <h4>界面信息密度</h4>
              <Select value={uiDensity} onValueChange={(v) => pickUiDensity(v as UiDensity)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="选择界面信息密度" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">紧凑 (Compact)</SelectItem>
                  <SelectItem value="cozy">标准 (Cozy)</SelectItem>
                  <SelectItem value="spacious">宽松 (Spacious)</SelectItem>
                </SelectContent>
              </Select>
              <div className="meta">调整全局间距、内边距和字体大小，以获得最舒适的阅读与操作体验。</div>
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
              <h4>右侧面板标签自定义</h4>
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
              <div className="meta mt-1.5">勾选以显示或隐藏右侧审查面板（ReviewPanel）中对应的标签页，至少保持显示一个标签。</div>
            </section>
          </>
        )}
        {activeCat === 'integrations' && (
          <div className="integration-stack">
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>{t('provider')}</h4>
                <p className="meta">管理模型 Provider、API Key 与可用模型。首个配置好的 Provider 会自动成为主控。</p>
              </div>
              <ProviderSettings />
            </section>
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>子代理 / 审查模型路由</h4>
                <p className="meta">把审查、团队、议事会等子代理路由到不同模型，避免它们和主会话争抢缓存。</p>
              </div>
              <RoutingSettings />
            </section>
            <section className="integration-card">
              <div className="integration-card-header">
                <h4>MCP 服务器</h4>
                <p className="meta">连接外部工具服务器（如 Context7），为 agent 提供文档查询等扩展能力。</p>
              </div>
              <McpSettingsManager />
            </section>
          </div>
        )}
        {activeCat === 'system' && (
          <div className="system-stack">
            <section className="system-card">
              <div className="system-card-header">
                <h4>{t('runtime')}</h4>
                <p className="meta">当前 sidecar 版本、会话数量与运行状态统计。</p>
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
            <StorageLocationSection />
            <StorageSection />
            <UpdaterSection />
          </div>
        )}
        {activeCat === 'help' && <HelpSection onNavigate={setActiveCat} />}
      </div>
    </div>
  )
}

type HelpTab = 'start' | 'commands' | 'config' | 'shortcuts'
const HELP_TABS: { id: HelpTab; label: string }[] = [
  { id: 'start', label: '快速开始' },
  { id: 'commands', label: '任务命令' },
  { id: 'config', label: '配置说明' },
  { id: 'shortcuts', label: '快捷键' },
]

interface HelpCmd {
  cmd: string
  desc: React.ReactNode
}
const HELP_COMMANDS: HelpCmd[] = [
  { cmd: '/team <任务>', desc: <>团队模式：拆解任务 → 多个 patcher 子代理分波并行；主控负责集成、验证、最终 <code>deliver_task</code>。也可传计划文件路径。</> },
  { cmd: '/team max <任务>', desc: <>强编队：执行前先做依赖分析 / 风险审计 / 对抗盲点搜索，再并行落地。适合大改动 / 高风险重构。</> },
  { cmd: '/council <目标>', desc: <>议事会：多星域专家对抗会诊，<strong>只出计划不执行</strong>。可指定席位、辩论轮数；每席可在「集成 → 路由」配成异构。</> },
  { cmd: '/review [关注点]', desc: <>L2 审查：对当前未提交改动派单个对抗验证审查员（<code>deliver_task</code> commit + L2）。</> },
  { cmd: '/review max [关注点]', desc: <>L3 审查编队：5 名审查员并行复核（<code>deliver_task</code> commit + L3）。大改动或交付前用它兜底。</> },
  { cmd: '/plan <功能>', desc: <>规划模式：先读代码，出一份带 Mermaid 图 + TDD 步骤的实现计划（不写实现代码），保存到 <code>docs/superpowers/plans/</code>。</> },
]

/**
 * In-app user guide. Organised into topic tabs so first-time users can scan
 * what the help page covers instead of facing one long stacked list.
 */
function HelpSection({ onNavigate }: { onNavigate: (cat: SettingsCat) => void }) {
  const [tab, setTab] = useState<HelpTab>('start')

  return (
    <Tabs value={tab} onValueChange={(v) => { if (v) setTab(v as HelpTab) }} className="help-tabs">
      <TabsList variant="line" className="help-tabs-list">
        {HELP_TABS.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className="help-tab-trigger">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="start">
        <div className="help-card">
          <h4>快速开始</h4>
          <ol className="help-steps">
            <li>在「集成」里添加一个模型 Provider，并填入 API Key（首个 Provider 会自动设为主控模型）。</li>
            <li>到「行为」选择新线程的默认自治档位。</li>
            <li>用 <kbd>⌘N</kbd> 新建线程，描述你的任务，天枢会自主完成编码。</li>
          </ol>
          <button className="btn" onClick={() => onNavigate('integrations')}>前往「集成」配置 Provider →</button>
        </div>
      </TabsContent>

      <TabsContent value="commands">
        <div className="help-card">
          <h4>关键任务命令</h4>
          <p className="help-lead">
            在输入框打 <kbd>/</kbd> 会弹出命令补全，也可用 <kbd>⌘K</kbd> 命令面板。
            带 <code>&lt;…&gt;</code> 的需要在命令后跟上你的任务描述。
          </p>
          <div className="help-cmds-grid">
            {HELP_COMMANDS.map((c) => (
              <div key={c.cmd} className="help-cmd-card">
                <code>{c.cmd}</code>
                <p>{c.desc}</p>
              </div>
            ))}
          </div>
          <div className="help-hint">
            重型并发命令（<code>/team</code> / <code>/review max</code> / <code>/council</code>）会派出子代理——
            务必先配好「子代理 / 审查模型路由」，否则子代理和主控抢同一个无缓存 Provider 会拖慢主对话。
          </div>
        </div>
      </TabsContent>

      <TabsContent value="config">
        <div className="help-cards-stack">
          <div className="help-card">
            <h4>模型 Provider 与 API Key</h4>
            <p className="help-lead">
              在「集成 → 模型 Provider」里管理多个 Provider（DeepSeek / GLM / Kimi / Codex 等）。
              其中一个被标记为「主控」，即对话主循环使用的模型。Key 只存在本地
              <code>~/.rivet/config.json</code>，不会上传。
            </p>
            <button className="btn" onClick={() => onNavigate('integrations')}>前往「集成」配置 →</button>
          </div>

          <div className="help-card">
            <h4>子代理 / 审查模型路由（重要）</h4>
            <p className="help-lead">
              天枢在「提交后审查」和「能力任务委派」时会派出子代理。如果子代理和主控用
              <strong>同一个无服务端前缀缓存的 Provider</strong>（GLM / Kimi / Codex 等），并发请求会
              <strong>抢占并驱逐主会话的服务端缓存</strong>，导致主对话突然变慢甚至看起来卡死。
            </p>
            <p className="help-lead">
              解决办法：把子代理路由到一个便宜的「副模型」（如 DeepSeek Flash）。支持<strong>跨 Provider</strong>路由——
              主控用 GLM，子代理走 DeepSeek Flash，两条缓存互不干扰。若指定的 Provider / 模型不存在或缺 Key，会静默回退到主控模型。
            </p>
            <button className="btn" onClick={() => onNavigate('integrations')}>前往「集成」配置路由 →</button>
          </div>

          <div className="help-card">
            <h4>自治档位</h4>
            <p className="help-lead">
              在「行为 → 新线程默认自治档位」设置。高档位在项目目录内全自动执行；
              项目目录外的写入仍受沙箱限制，且任何改动都可回滚。
            </p>
            <button className="btn" onClick={() => onNavigate('behavior')}>前往「行为」设置 →</button>
          </div>

          <div className="help-card">
            <h4>配置文件与数据位置</h4>
            <dl className="help-kv">
              <div><dt>主配置</dt><dd><code>~/.rivet/config.json</code></dd></div>
              <div><dt>项目级覆盖</dt><dd>项目根目录 <code>.rivet-config.json</code></dd></div>
              <div><dt>会话日志</dt><dd><code>~/.rivet/sessions/&lt;项目&gt;/</code></dd></div>
              <div><dt>配置示例</dt><dd>仓库根目录 <code>config.example.json</code></dd></div>
            </dl>
            <p className="help-lead">
              手改配置后无需重启桌面端，下一次新建会话即生效。加载器只接受 JSON 格式，键名为 camelCase。
            </p>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="shortcuts">
        <div className="help-card">
          <h4>常用快捷键</h4>
          <dl className="help-shortcuts">
            <div><dt><kbd>⌘K</kbd></dt><dd>打开命令面板</dd></div>
            <div><dt><kbd>⌘N</kbd></dt><dd>新建线程</dd></div>
            <div><dt><kbd>⌘B</kbd></dt><dd>展开 / 收起左侧项目侧边栏</dd></div>
            <div><dt><kbd>⌘⇧B</kbd></dt><dd>展开 / 收起右侧审查面板</dd></div>
            <div><dt><kbd>/</kbd></dt><dd>在输入框使用斜杠命令</dd></div>
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
      toast.error(`开机自启设置失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [enabled, busy])

  if (!isTauri || enabled === null) return null

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>开机自启</h4>
        <p className="meta">登录系统时自动启动天枢（Windows 注册表 Run 键 / macOS LaunchAgent）。</p>
      </div>
      <label className="flex items-center gap-2 text-xs text-text" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={() => void toggle()}
        />
        <span>{enabled ? '已启用 — 登录时自动启动' : '未启用'}</span>
      </label>
    </section>
  )
}

/** C3 — Auto 模式检查点间隔。权限模式（Manual/Auto/YOLO）通过 AutonomyControl 切换。 */
function CheckpointSection() {
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
      setMsg('已保存 · 新会话生效')
    } catch (err) {
      setMsg(`保存失败：${(err as Error).message}`)
    }
  }, [])

  if (cfg === null) return null

  const presetIntervals = [20, 25, 30]
  const isPreset = presetIntervals.includes(cfg.checkpointEveryTurns)

  const applyCustomInterval = () => {
    const v = Number(customInterval)
    if (!Number.isInteger(v) || v < 0) {
      setMsg('轮数必须是非负整数（0 = 关）')
      return
    }
    setCustomInterval('')
    void update({ checkpointEveryTurns: v })
  }

  return (
    <section className="settings-group">
      <h4>Auto 检查点</h4>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <Select
          value={isPreset ? String(cfg.checkpointEveryTurns) : 'custom'}
          onValueChange={(v) => { if (v !== 'custom') void update({ checkpointEveryTurns: Number(v) }) }}
        >
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="20">每 20 轮暂停</SelectItem>
            <SelectItem value="25">每 25 轮暂停（推荐）</SelectItem>
            <SelectItem value="30">每 30 轮暂停</SelectItem>
            {!isPreset && (
              <SelectItem value="custom">
                {cfg.checkpointEveryTurns === 0 ? '已关闭' : `每 ${cfg.checkpointEveryTurns} 轮暂停（自定义）`}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <input
          className="settings-input"
          style={{ width: 96 }}
          inputMode="numeric"
          placeholder="自定义轮数"
          value={customInterval}
          onChange={(e) => setCustomInterval(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyCustomInterval() }}
        />
        <button type="button" className="btn-sm" onClick={applyCustomInterval} disabled={!customInterval.trim()}>
          应用
        </button>
      </div>
      <div className="meta">
        Auto 模式下，每隔 N 轮暂停并同步进度摘要。默认关闭（0 = 不暂停）。仅在 auto-safe 模式下生效；YOLO 和 Manual 模式不受影响。权限模式通过上方 Autonomy 控件切换。
      </div>
      {msg && <div className="meta">{msg}</div>}
    </section>
  )
}

function PlatformSection() {
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
      setMsg('已保存 · 重启应用后生效')
    } catch (err) {
      setMsg(`保存失败：${(err as Error).message}`)
    }
  }, [])

  if (!cfg) return null

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>平台约定（换行符 / 目标系统）</h4>
        <p className="meta">控制新建文件的换行符，以及系统提示里告诉模型的目标 OS。<code>auto</code> 跟随本机。命令始终在本机 shell 执行——跨平台覆盖只影响文件约定，不改变命令执行。</p>
      </div>
      <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
        <label className="flex items-center gap-2 text-xs text-text">
          <span className="text-muted">目标平台</span>
          <Select value={cfg.platform} onValueChange={(v) => void update({ platform: v as EditorPlatform })}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动（跟随本机）</SelectItem>
              <SelectItem value="windows">Windows (CRLF)</SelectItem>
              <SelectItem value="macos">macOS (LF)</SelectItem>
              <SelectItem value="linux">Linux (LF)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-2 text-xs text-text">
          <span className="text-muted">换行符</span>
          <Select value={cfg.eol} onValueChange={(v) => void update({ eol: v as EditorEol })}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动（由平台推导）</SelectItem>
              <SelectItem value="lf">LF</SelectItem>
              <SelectItem value="crlf">CRLF</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}
      <div className="meta" style={{ marginTop: 6 }}>
        <code>.bat</code> / <code>.cmd</code> 始终用 CRLF；已存在的文件始终沿用其原有换行符。也可在项目根的 <code>.rivet-config.json</code> 的 <code>editor</code> 段做按项目覆盖。
      </div>
    </section>
  )
}

function ShellSection() {
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
        setMsg('已保存，但该路径当前不存在 — 装好 Git 或修正路径后重启应用生效')
      } else if (next.gitBashPath) {
        setMsg('已保存 · 重启应用后生效')
      } else {
        setMsg('已清除自定义路径 · 重启应用后回到自动探测')
      }
      void getEnvironment().then(setEnv).catch(() => {})
    } catch (err) {
      setMsg(`保存失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [path])

  // Git Bash override only affects command execution on Windows. Hide the whole
  // card elsewhere to avoid confusing macOS/Linux users. Render nothing until
  // the environment probe resolves so we don't flash then vanish.
  if (!env) return null
  if (env.platform !== 'win32') return null

  const shell = env.shell
  const usingBash = shell?.kind === 'bash'
  const statusText = shell
    ? usingBash
      ? `命令执行使用 Git Bash（${shell.kind}）`
      : `⚠ 未使用 Git Bash — 已退回 ${shell.kind}，部分命令可能异常或无输出`
    : '未获取到 shell 状态'

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>命令执行 Shell（Git Bash 路径）</h4>
        <p className="meta">
          Windows 上天枢优先用 Git 自带的 Git Bash 执行命令（更可靠的 POSIX 行为）。装在非默认位置、或想指定自带 Git 时，在此填 <code>bash.exe</code> 的完整路径。留空则自动探测（系统 Git → 常见位置 → 内置 PortableGit）。系统环境变量 <code>RIVET_GIT_BASH_PATH</code> 优先级更高。
        </p>
      </div>
      <div className={`meta ${usingBash ? '' : 'warn'}`} style={{ marginBottom: 8 }}>
        当前：{statusText}
        {shell?.gitBashAvailable === false && '（未检测到可用 Git Bash）'}
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
          {busy ? '保存中…' : '保存'}
        </Button>
        {saved && (
          <Button variant="outline" onClick={() => { setPath(''); }} disabled={busy}>
            清除
          </Button>
        )}
      </div>
      {saved && exists === false && (
        <div className="meta warn" style={{ marginTop: 6 }}>已保存的路径不存在：<code>{saved}</code></div>
      )}
      {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  )
}

function StorageLocationSection() {
  const handleApplied = async (requiresRestart: boolean) => {
    if (requiresRestart) {
      toast.success('存储位置已保存，应用即将重启')
      try {
        await relaunch()
      } catch {
        window.location.reload()
      }
    } else {
      toast.success('存储位置已保存')
    }
  }

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>存储位置</h4>
        <p className="meta">设置天枢数据根目录（RIVET_HOME）。更改后需重启应用，可选择是否迁移已有数据。</p>
      </div>
      <StorageLocationPanel onApplied={handleApplied} />
    </section>
  )
}

function StorageSection() {
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
      setMsg(`已清理 ${res.deleted} 个归档会话，释放 ${formatBytes(res.freedBytes)}`)
      await refresh()
    } catch (err) {
      setMsg(`清理失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const archived = report?.archived ?? []

  return (
    <section className="system-card">
      <div className="system-card-header">
        <h4>存储管理</h4>
        <p className="meta">查看会话文件占用，清理已归档会话以释放磁盘空间。删除不可逆，进行中的会话不受影响。</p>
      </div>
      {loading && !report ? (
        <div className="meta">正在统计…</div>
      ) : !report ? (
        <div className="meta warn">无法读取存储信息（sidecar 离线？）</div>
      ) : (
        <>
          <dl className="kv">
            <div><dt>会话文件总占用</dt><dd>{formatBytes(report.totalBytes)}</dd></div>
            <div><dt>会话总数</dt><dd>{report.sessionCount}</dd></div>
            <div><dt>已归档会话</dt><dd>{report.archivedCount} 个 · {formatBytes(report.archivedBytes)} 可回收</dd></div>
          </dl>

          <div className="meta" style={{ marginTop: 8 }}>
            归档会话的对话记录会一直保留在磁盘上。下面只清理「已归档」的会话，进行中的会话不受影响。<strong>删除不可逆。</strong>
          </div>

          <div className="flex items-center gap-2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={busy || archived.length === 0}
              onClick={() => runCleanup(
                { olderThanDays: days },
                `确定清理 ${days} 天前的所有归档会话吗？此操作不可恢复。`,
              )}
            >
              清理
              <input
                type="number"
                min={0}
                value={days}
                onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))}
                onClick={(e) => e.stopPropagation()}
                style={{ width: 52, margin: '0 4px', textAlign: 'center' }}
              />
              天前的归档
            </button>
            <button
              className="btn btn-danger"
              disabled={busy || archived.length === 0}
              onClick={() => runCleanup(
                {},
                `确定清理全部 ${archived.length} 个归档会话吗？将释放约 ${formatBytes(report.archivedBytes)}，此操作不可恢复。`,
              )}
            >
              清理全部归档（{archived.length}）
            </button>
            <button className="btn" disabled={loading || busy} onClick={() => void refresh()}>刷新</button>
          </div>

          {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}

          {archived.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="meta">归档会话（按最早在前）：</div>
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
                          `删除归档会话「${s.title || s.id}」(${formatBytes(s.bytes)})？此操作不可恢复。`,
                        )}
                      >删除</button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
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
        <p className="meta">检查并安装应用更新。下载完成后会自动重启以完成安装。</p>
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

/** Inner component that manages MCP status polling and delegates to McpSettings UI. */
function McpSettingsManager() {
  const [mcpStatus, setMcpStatus] = useState<McpStatusResponse | null>(null)
  const [mcpLoading, setMcpLoading] = useState(true)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [presets, setPresets] = useState<McpPreset[] | null>(null)
  const [configuredIds, setConfiguredIds] = useState<string[]>([])

  const fetchStatus = useCallback(() => {
    getMcpStatus()
      .then((s) => { setMcpStatus(s); setMcpError(null) })
      .catch((err) => setMcpError((err as Error).message))
      .finally(() => setMcpLoading(false))
    getMcpPresets()
      .then((p) => { setPresets(p.presets); setConfiguredIds(p.configuredIds) })
      .catch(() => { /* non-fatal: preset grid just won't render */ })
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleAdd = useCallback((config: McpServerConfig) => {
    addMcpServer(config)
      .then(() => fetchStatus())
      .catch((err) => setMcpError((err as Error).message))
  }, [fetchStatus])

  const handleRemove = useCallback((serverId: string) => {
    removeMcpServer(serverId)
      .then(() => fetchStatus())
      .catch((err) => setMcpError((err as Error).message))
  }, [fetchStatus])

  const handleRestart = useCallback((serverId: string) => {
    restartMcpServer(serverId)
      .then(() => fetchStatus())
      .catch((err) => setMcpError((err as Error).message))
  }, [fetchStatus])

  return (
    <McpSettings
      status={mcpStatus}
      statusLoading={mcpLoading}
      statusError={mcpError}
      presets={presets}
      configuredIds={configuredIds}
      onAdd={handleAdd}
      onRemove={handleRemove}
      onRestart={handleRestart}
    />
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
