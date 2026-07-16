import { readFileSync, existsSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { resolve, join } from 'path'
import { z } from 'zod'
import { configSchema, reviewConfigSchema, workersSchema, councilConfigSchema, editorSchema, mirrorsSchema, envSchema, uiSchema, permissionsSchema, networkSchema, type Config, type ProviderConfig, type ModelConfig, type ReviewConfig, type WorkersConfig, type CouncilConfig, type EditorConfig, type MirrorsConfig, type UiConfig } from './schema.js'
import { DEFAULT_CONFIG } from './default.js'
import { userConfigPath } from './paths.js'
import { cloneProviderPreset, findPresetModel, isProviderPresetKey, type ProviderPresetKey } from './provider-presets.js'

const APPROVAL_MODES = ['auto-safe', 'manual', 'auto-accept', 'dangerously-skip-permissions'] as const
type ApprovalModeConfig = typeof APPROVAL_MODES[number]

export function getUserConfigPath(): string {
  return userConfigPath()
}

/** Project-level config file name (checked in cwd and parent dirs) */
const PROJECT_CONFIG_FILE = '.rivet-config.json'

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv === null) {
      delete result[key]
    } else if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      result[key] = sv
    }
  }
  return result
}

/**
 * Walk up from startDir to find the nearest .rivet-config.json.
 * Returns the absolute path or undefined if not found.
 */
export function findProjectConfig(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, PROJECT_CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break // reached root
    dir = parent
  }
  return undefined
}

/**
 * One-shot legacy migration for the C3 autonomy brake (2026-07): configs
 * written before `autonomyBrake` existed persisted the then-default
 * `checkpointEveryTurns: 10`. The default since moved to 0 (off) — a
 * persisted 10 would pin them to the old behavior forever.  When the brake
 * field is absent AND the interval equals the old default, treat the 10 as
 * unmigrated legacy and drop it so the new schema default applies.
 * Explicit non-10 values (user actually tuned it) are untouched.
 */
function migrateLegacyCheckpointInterval(raw: Record<string, unknown>): Record<string, unknown> {
  const agent = raw.agent
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return raw
  const a = agent as Record<string, unknown>
  if (a.autonomyBrake === undefined && a.checkpointEveryTurns === 10) {
    const { checkpointEveryTurns: _legacy, ...rest } = a
    return { ...raw, agent: rest }
  }
  return raw
}

/**
 * One-shot migration for the DeepSeek V4 maxTokens regression (2026-07):
 * a98fe5472 mistakenly reduced v4-pro/v4-flash maxTokens from 384_000 to
 * 64_000 (the V3-era limit). df576e01 restored the preset, but configs
 * written during the regression window have the stale 64_000 baked in.
 * Since deepMerge replaces arrays wholesale, the user's models array with
 * stale per-model maxTokens wins over the corrected preset — the preset
 * fix alone doesn't reach existing users.
 *
 * This migration patches both the provider-level maxTokens AND every model
 * in the models array whose maxTokens === 64_000 (the exact regression
 * value). Explicit non-64_000 values (user intentionally configured a
 * different cap) are left untouched.
 *
 * Mutates `raw` in place. Returns true if any value was changed.
 */
function migrateDeepseekMaxTokens(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false

  const ds = providers['deepseek'] as Record<string, unknown> | undefined
  if (!ds) return false

  let changed = false

  // Provider-level maxTokens
  if (typeof ds.maxTokens === 'number' && ds.maxTokens === 64_000) {
    ds.maxTokens = 384_000
    changed = true
  }

  // Per-model maxTokens (within the models array). Never raise maxTokens above
  // the model's own contextWindow — a custom model with a small window may
  // legitimately carry maxTokens=64_000 (the clamp backstop produces exactly
  // that value), and bumping it past the window recreates the mis-config that
  // clampModelTokens exists to prevent.
  const models = ds.models as Array<Record<string, unknown>> | undefined
  if (Array.isArray(models)) {
    for (const m of models) {
      if (typeof m.maxTokens === 'number' && m.maxTokens === 64_000) {
        const window = typeof m.contextWindow === 'number' ? m.contextWindow : Infinity
        if (window >= 384_000) {
          m.maxTokens = 384_000
          changed = true
        }
      }
    }
  }

  return changed
}

/**
 * Load config with 3-layer resolution: user → project → session overlay.
 *
 * Priority (highest wins):
 * 1. sessionOverlay — runtime-only, per-session overrides (never persisted here)
 * 2. projectConfig — .rivet-config.json found by walking up from cwd
 * 3. userConfig — ~/.rivet/config.json (global)
 * 4. DEFAULT_CONFIG — built-in defaults
 *
 * Each layer is deep-merged onto the previous, then the result is
 * validated through the Zod configSchema.
 */
export function loadConfig(options?: {
  cwd?: string
  projectConfigPath?: string
  sessionOverlay?: Record<string, unknown>
}): Config {
  // Layer 1: defaults
  let base = DEFAULT_CONFIG as unknown as Record<string, unknown>

  // Layer 2: user global config
  const configPath = getUserConfigPath()
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      const cpMigrated = migrateLegacyCheckpointInterval(raw as Record<string, unknown>)
      const dsChanged = migrateDeepseekMaxTokens(cpMigrated)
      // Write back if any migration modified the raw config so the fix
      // persists across restarts (one-shot, idempotent).
      if (cpMigrated !== raw || dsChanged) {
        try {
          writeFileAtomicSync(configPath, JSON.stringify(cpMigrated, null, 2) + '\n')
        } catch {
          // best-effort — migration still applied in memory
        }
      }
      base = deepMerge(base, cpMigrated)
    } catch {
      // malformed user config — fall through to defaults
    }
  }

  // Layer 3: project config
  const projectPath = options?.projectConfigPath
    ?? (options?.cwd ? findProjectConfig(options.cwd) : undefined)
  if (projectPath && existsSync(projectPath)) {
    try {
      const raw = JSON.parse(readFileSync(projectPath, 'utf-8'))
      const cpMigrated = migrateLegacyCheckpointInterval(raw as Record<string, unknown>)
      migrateDeepseekMaxTokens(cpMigrated)
      // NOTE: no write-back for project configs — they may be version-controlled.
      base = deepMerge(base, cpMigrated)
    } catch {
      // malformed project config — skip
    }
  }

  // Layer 4: session overlay (runtime-only, e.g. from CLI flags)
  if (options?.sessionOverlay) {
    base = deepMerge(base, options.sessionOverlay)
  }

  return configSchema.parse(base)
}

/** Load config with backward-compatible signature (no options). */
export function loadConfigDefault(): Config {
  return loadConfig()
}

export function saveConfig(config: Config): void {
  writeFileAtomicSync(getUserConfigPath(), JSON.stringify(config, null, 2) + '\n')
}

// --- Provider management ---

export function listProviders(): string[] {
  return Object.keys(loadConfig().provider.providers)
}

export function getProvider(name: string): ProviderConfig | undefined {
  return loadConfig().provider.providers[name]
}

export function getDefaultProvider(): string {
  return loadConfig().provider.default
}

export function addProvider(name: string, config: ProviderConfig): void {
  const cfg = loadConfig()
  cfg.provider.providers[name] = config
  saveConfig(cfg)
}

export function removeProvider(name: string): void {
  const cfg = loadConfig()
  if (cfg.provider.default === name) {
    throw new Error(`Cannot remove default provider "${name}". Set a different default first.`)
  }
  delete cfg.provider.providers[name]
  saveConfig(cfg)
}

export function setDefaultProvider(name: string): void {
  const cfg = loadConfig()
  if (!cfg.provider.providers[name]) {
    throw new Error(`Provider "${name}" not found. Available: ${Object.keys(cfg.provider.providers).join(', ')}`)
  }
  cfg.provider.default = name
  saveConfig(cfg)
}

export function setApprovalMode(mode: string): ApprovalModeConfig {
  if (!(APPROVAL_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Invalid approval mode "${mode}". Available: ${APPROVAL_MODES.join(', ')}`)
  }
  const cfg = loadConfig()
  cfg.agent.approval = mode as ApprovalModeConfig
  saveConfig(cfg)
  return mode as ApprovalModeConfig
}

// --- Sub-agent / review routing management ---

/** Snapshot of the sub-agent routing blocks for the desktop settings UI.
 *  `council` carries per-seat provider/model for heterogeneous councils. */
export function getRoutingConfig(): { review: ReviewConfig; workers: WorkersConfig; council: CouncilConfig } {
  const cfg = loadConfig()
  return { review: cfg.agent.review, workers: cfg.workers, council: cfg.agent.council }
}

/**
 * Persist sub-agent routing config. Accepts any subset of blocks; each is
 * validated through its own schema before being written, so a malformed payload
 * never lands in config.json. Returns the resulting normalized blocks.
 */
export function setRoutingConfig(input: { review?: unknown; workers?: unknown; council?: unknown }): { review: ReviewConfig; workers: WorkersConfig; council: CouncilConfig } {
  const cfg = loadConfig()
  if (input.review !== undefined) {
    cfg.agent.review = reviewConfigSchema.parse(input.review)
  }
  if (input.workers !== undefined) {
    cfg.workers = workersSchema.parse(input.workers)
  }
  if (input.council !== undefined) {
    cfg.agent.council = councilConfigSchema.parse(input.council)
  }
  saveConfig(cfg)
  return { review: cfg.agent.review, workers: cfg.workers, council: cfg.agent.council }
}

// --- API key management ---

// --- Editor / target-platform conventions ---

/** Snapshot of the editor conventions block for the desktop settings UI. */
export function getEditorConfig(): EditorConfig {
  return loadConfig().editor
}

/**
 * Persist editor conventions (target platform + EOL) to the user global config.
 * Validated through editorSchema. Takes effect on the next sidecar/session start
 * (the target is resolved once at startup via setTargetConventions).
 */
export function setEditorConfig(input: { platform?: unknown; eol?: unknown }): EditorConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.editor }
  if (input.platform !== undefined) merged.platform = input.platform
  if (input.eol !== undefined) merged.eol = input.eol
  cfg.editor = editorSchema.parse(merged)
  saveConfig(cfg)
  return cfg.editor
}

// --- Shell / Git Bash 路径（Windows 命令执行） ---

export interface ShellConfigSnapshot {
  /** Configured custom Git Bash path, or empty string when unset. */
  gitBashPath: string
  /** Configured custom git executable path, or empty string when unset. */
  gitPath: string
}

/** Snapshot of the shell block (Git Bash / git override) for the desktop settings UI. */
export function getShellConfig(): ShellConfigSnapshot {
  const env = loadConfig().env
  return {
    gitBashPath: env.gitBashPath ?? '',
    gitPath: env.gitPath ?? '',
  }
}

/**
 * Persist a custom Git Bash path to the user global config (`env.gitBashPath`).
 * An empty/whitespace value clears the override. Takes effect on the next
 * sidecar/session start (seeded into RIVET_GIT_BASH_PATH via
 * applyConfiguredGitBashPath). Only meaningful on Windows.
 */
export function setShellConfig(input: { gitBashPath?: unknown; gitPath?: unknown }): ShellConfigSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.env }
  if (input.gitBashPath !== undefined) {
    const raw = String(input.gitBashPath).trim()
    if (raw) merged.gitBashPath = raw
    else delete merged.gitBashPath
  }
  if (input.gitPath !== undefined) {
    const raw = String(input.gitPath).trim()
    if (raw) merged.gitPath = raw
    else delete merged.gitPath
  }
  cfg.env = envSchema.parse(merged)
  saveConfig(cfg)
  return {
    gitBashPath: cfg.env.gitBashPath ?? '',
    gitPath: cfg.env.gitPath ?? '',
  }
}

// --- 网络代理配置（web_fetch / import_resource 的 HTTP 代理） ---

export interface NetworkConfigSnapshot {
  proxy: string
  noProxy: string
}

/** 读取用户全局 config 的 network 段（web_fetch 代理配置）。 */
export function getNetworkConfig(): NetworkConfigSnapshot {
  const net = loadConfig().network
  return {
    proxy: net.proxy ?? '',
    noProxy: net.noProxy ?? '',
  }
}

/**
 * 持久化 HTTP 代理配置到用户全局 config（`network.proxy` / `network.noProxy`）。
 * 空值清除覆盖，回退到环境变量 HTTPS_PROXY/HTTP_PROXY/NO_PROXY。
 * 下次 sidecar/session 启动时生效（buildFetchOptions → httpFetchGuarded）。
 */
export function setNetworkConfig(input: { proxy?: unknown; noProxy?: unknown }): NetworkConfigSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.network }
  if (input.proxy !== undefined) {
    const raw = String(input.proxy).trim()
    if (raw) merged.proxy = raw
    else delete merged.proxy
  }
  if (input.noProxy !== undefined) {
    const raw = String(input.noProxy).trim()
    if (raw) merged.noProxy = raw
    else delete merged.noProxy
  }
  cfg.network = networkSchema.parse(merged)
  saveConfig(cfg)
  return {
    proxy: cfg.network.proxy ?? '',
    noProxy: cfg.network.noProxy ?? '',
  }
}

// --- Codex 式常驻目录授权（agent.permissions.additionalReadDirs/WriteDirs） ---

export interface PermissionDirsSnapshot {
  additionalReadDirs: string[]
  additionalWriteDirs: string[]
}

/** Snapshot of the standing directory grants for the desktop settings UI. */
export function getPermissionDirs(): PermissionDirsSnapshot {
  const p = loadConfig().agent.permissions
  return {
    additionalReadDirs: [...(p.additionalReadDirs ?? [])],
    additionalWriteDirs: [...(p.additionalWriteDirs ?? [])],
  }
}

/**
 * Persist the standing directory grants to the user global config. Each entry
 * is an absolute or ~-relative directory whose subtree becomes readable /
 * read+writable without an approval round-trip (a drive root grants the whole
 * drive). Entries are trimmed and deduplicated; validation via permissionsSchema.
 * Additions can be applied to the running process by the caller
 * (applyConfiguredPathGrants); removals take effect on the next sidecar start.
 */
export function setPermissionDirs(input: {
  additionalReadDirs?: unknown
  additionalWriteDirs?: unknown
}): PermissionDirsSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.agent.permissions }
  const normalize = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
      throw new Error(`${field} must be an array of strings`)
    }
    return [...new Set((v as string[]).map(s => s.trim()).filter(Boolean))]
  }
  if (input.additionalReadDirs !== undefined) {
    merged.additionalReadDirs = normalize(input.additionalReadDirs, 'additionalReadDirs')
  }
  if (input.additionalWriteDirs !== undefined) {
    merged.additionalWriteDirs = normalize(input.additionalWriteDirs, 'additionalWriteDirs')
  }
  cfg.agent.permissions = permissionsSchema.parse(merged)
  saveConfig(cfg)
  return {
    additionalReadDirs: [...cfg.agent.permissions.additionalReadDirs],
    additionalWriteDirs: [...cfg.agent.permissions.additionalWriteDirs],
  }
}

// --- Auto 检查点 (C3) ---

export interface CheckpointConfigSnapshot {
  checkpointEveryTurns: number
}

/** Snapshot of the checkpoint interval for the desktop/TUI settings UI. */
export function getCheckpointConfig(): CheckpointConfigSnapshot {
  return { checkpointEveryTurns: loadConfig().agent.checkpointEveryTurns }
}

/**
 * Persist the checkpoint interval for Auto mode (auto-safe).
 * 0 = off (no pause). Takes effect at the next run().
 */
export function setCheckpointConfig(input: {
  checkpointEveryTurns?: unknown
}): CheckpointConfigSnapshot {
  const cfg = loadConfig()
  if (input.checkpointEveryTurns !== undefined) {
    const v = Number(input.checkpointEveryTurns)
    if (!Number.isInteger(v) || v < 0) throw new Error('checkpointEveryTurns must be a non-negative integer')
    cfg.agent.checkpointEveryTurns = v
  }
  saveConfig(cfg)
  return { checkpointEveryTurns: cfg.agent.checkpointEveryTurns }
}

// --- Vision model bridge (multimodal image recognition) ---

const visionModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().optional(),
  maxTokens: z.number().int().positive().default(1024),
})

export interface VisionModelConfigSnapshot {
  provider: string
  model: string
  prompt?: string
  maxTokens: number
}

/** Snapshot of the optional vision bridge model for the desktop/TUI settings UI. */
export function getVisionModelConfig(): VisionModelConfigSnapshot | null {
  return loadConfig().agent.visionModel ?? null
}

/**
 * Persist the vision bridge model to the user global config.
 * Pass `null` or empty provider/model to clear the bridge.
 * Takes effect on the next session start.
 */
export function setVisionModelConfig(
  input: { provider?: unknown; model?: unknown; prompt?: unknown; maxTokens?: unknown } | null,
): VisionModelConfigSnapshot | null {
  const cfg = loadConfig()
  if (input === null || input.provider === '' || input.model === '') {
    delete (cfg.agent as Record<string, unknown>).visionModel
    saveConfig(cfg)
    return null
  }
  const parsed = visionModelConfigSchema.parse(input)
  cfg.agent.visionModel = parsed
  saveConfig(cfg)
  return parsed
}

/** Snapshot of the mirror configuration block. */
export function getMirrorConfig(): MirrorsConfig {
  return loadConfig().mirrors
}

/**
 * Persist mirror configuration to the user global config.
 * Validated through mirrorsSchema. Takes effect on the next bash execution.
 */
export function setMirrorConfig(input: {
  enabled?: unknown
  preset?: unknown
  github?: unknown
  npm?: unknown
  pypi?: unknown
  go?: unknown
  rust?: unknown
}): MirrorsConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.mirrors }
  for (const key of ['enabled', 'preset', 'github', 'npm', 'pypi', 'go', 'rust'] as const) {
    if (input[key] !== undefined) merged[key] = input[key]
  }
  cfg.mirrors = mirrorsSchema.parse(merged)
  saveConfig(cfg)
  return cfg.mirrors
}

/** Snapshot of the UI preferences block for the TUI settings panel. */
export function getUiConfig(): UiConfig {
  return loadConfig().ui
}

/**
 * Persist UI preferences (default theme, etc.) to the user global config.
 * Validated through uiSchema. Theme changes take effect on the next session start.
 */
export function setUiConfig(input: { theme?: unknown }): UiConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.ui }
  if ('theme' in input) {
    if (input.theme === undefined) {
      delete merged.theme
    } else {
      merged.theme = input.theme
    }
  }
  cfg.ui = uiSchema.parse(merged)
  saveConfig(cfg)
  return cfg.ui
}

export function setApiKey(providerName: string, key: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.apiKey = key
  ;(provider as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  saveConfig(cfg)
}

export function setApiKeyEnv(providerName: string, envVar: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.apiKeyEnv = envVar
  ;(provider as unknown as { apiKey?: string | null }).apiKey = null
  saveConfig(cfg)
}

export function getApiKeyStatus(providerName: string): { source: 'inline' | 'env' | 'none'; ref: string } {
  const provider = getProvider(providerName)
  if (!provider) return { source: 'none', ref: '' }
  if (provider.apiKey) return { source: 'inline', ref: '***' + provider.apiKey.slice(-4) }
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return { source: 'env', ref: provider.apiKeyEnv }
  }
  // Standard env var fallback so the UI shows "env" even when apiKeyEnv is missing.
  const defaultEnvVar = `${providerName.toUpperCase()}_API_KEY`
  if (process.env[defaultEnvVar]) return { source: 'env', ref: defaultEnvVar }
  return { source: 'none', ref: '' }
}

export interface UpsertProviderModelOptions {
  preferred?: boolean
}

export interface SetupProviderOptions {
  providerName: string
  preset?: ProviderPresetKey
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  model?: ModelConfig
  makeDefault?: boolean
  allowProFallback?: boolean
}

function assertValidUrl(value: string): void {
  try {
    new URL(value)
  } catch {
    throw new Error(`Invalid provider baseUrl: ${value}`)
  }
}

export function updateProviderBaseUrl(providerName: string, baseUrl: string): void {
  assertValidUrl(baseUrl)
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.baseUrl = baseUrl
  saveConfig(cfg)
}

/**
 * Clamp a model's output ceiling to its context window. `maxTokens` is the
 * single-response output cap and can never exceed the total window; letting a
 * mis-typed value through (e.g. maxTokens=1M on a 128K model) skews compaction
 * headroom and can trip provider 400s. This is the shared backstop for every
 * config write path (wizard, desktop form, direct upsert).
 */
export function clampModelTokens<T extends { contextWindow: number; maxTokens: number }>(model: T): T {
  const contextWindow = Math.max(1, Math.floor(model.contextWindow))
  const maxTokens = Math.max(1, Math.min(Math.floor(model.maxTokens), contextWindow))
  return { ...model, contextWindow, maxTokens }
}

export function upsertProviderModel(providerName: string, model: ModelConfig, options: UpsertProviderModelOptions = {}): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  model = clampModelTokens(model)
  const existingIndex = provider.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
  if (existingIndex >= 0) provider.models[existingIndex] = model
  else provider.models.push(model)
  if (options.preferred) {
    const preferredIndex = provider.models.findIndex(item => item.id === model.id)
    const preferred = provider.models.splice(preferredIndex, 1)[0]
    if (preferred) provider.models.unshift(preferred)
  }
  saveConfig(cfg)
}

export function setProviderAllowProFallback(providerName: string, allowProFallback: boolean): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.allowProFallback = allowProFallback
  saveConfig(cfg)
}

export function setupProvider(options: SetupProviderOptions): void {
  const cfg = loadConfig()
  const presetKey = options.preset ?? (isProviderPresetKey(options.providerName) ? options.providerName : undefined)
  const current = cfg.provider.providers[options.providerName]
  const base = presetKey ? cloneProviderPreset(presetKey) : current
  if (!base) throw new Error(`Provider "${options.providerName}" not found and no preset is available`)
  const next: ProviderConfig = structuredClone(base)
  next.name = options.providerName
  if (current) Object.assign(next, current)
  if (options.baseUrl) {
    assertValidUrl(options.baseUrl)
    next.baseUrl = options.baseUrl
  }
  if (options.apiKey) {
    next.apiKey = options.apiKey
    ;(next as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  }
  if (options.apiKeyEnv) {
    next.apiKeyEnv = options.apiKeyEnv
    ;(next as unknown as { apiKey?: string | null }).apiKey = null
  }
  if (options.model) {
    const model = clampModelTokens(options.model)
    const existingIndex = next.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
    if (existingIndex >= 0) next.models[existingIndex] = model
    else next.models.unshift(model)
  }
  cfg.provider.providers[options.providerName] = next
  if (options.makeDefault) cfg.provider.default = options.providerName
  if (options.allowProFallback !== undefined) {
    next.allowProFallback = options.allowProFallback
  }
  saveConfig(cfg)
}

export interface SetupCustomProviderOptions {
  providerName: string
  baseUrl: string
  /** API key — optional for local deployments (Ollama/vLLM) that need no auth. */
  apiKey?: string
  model: { id: string; alias?: string; contextWindow: number; maxTokens: number; reasoningEffort?: ModelConfig['reasoningEffort'] }
  makeDefault?: boolean
  allowProFallback?: boolean
}

/**
 * Create (or overwrite) a brand-new OpenAI-compatible provider from the minimal
 * inputs the in-TUI /connect DIY wizard collects. Unlike `setupProvider`, this
 * does not require an existing entry or a built-in preset — it materializes a
 * complete `ProviderConfig` with conservative capability defaults (no vendor
 * prefix-cache assumptions, no param stripping) so any OpenAI-wire endpoint
 * works out of the box.
 */
export function setupCustomProvider(options: SetupCustomProviderOptions): void {
  assertValidUrl(options.baseUrl)
  const contextWindow = Math.max(1, Math.floor(options.model.contextWindow))
  const maxTokens = Math.max(1, Math.min(Math.floor(options.model.maxTokens), contextWindow))
  const model: ModelConfig = {
    id: options.model.id,
    ...(options.model.alias ? { alias: options.model.alias } : {}),
    contextWindow,
    maxTokens,
    ...(options.model.reasoningEffort ? { reasoningEffort: options.model.reasoningEffort } : {}),
  }
  const provider: ProviderConfig = {
    name: options.providerName,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    baseUrl: options.baseUrl,
    protocol: 'openai',
    capabilities: {
      cacheControl: false,
      stripParams: [],
      toolJsonBug: false,
      prefixCache: 'none',
      prefixCompletion: false,
    },
    thinking: 'enabled',
    maxTokens,
    allowProFallback: options.allowProFallback ?? false,
    models: [model],
    unsupported: [],
  }
  const cfg = loadConfig()
  cfg.provider.providers[options.providerName] = provider
  if (options.makeDefault) cfg.provider.default = options.providerName
  saveConfig(cfg)
}

// --- Model management ---

export function addModel(providerName: string, model: ModelConfig): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.models.push(model)
  saveConfig(cfg)
}

export function removeModel(providerName: string, modelId: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.models = provider.models.filter(m => m.id !== modelId)
  // Auto-remove empty provider — a provider with zero models has no use.
  if (provider.models.length === 0) {
    delete cfg.provider.providers[providerName]
  }
  saveConfig(cfg)
}

export function listModels(providerName: string): ModelConfig[] {
  const provider = getProvider(providerName)
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  return provider.models
}

// --- CLI entry point ---

export interface ConfigCliIO {
  isTTY?: boolean
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  exit?: (code: number) => void
  runWizard?: () => Promise<void>
}

function cliOut(io: ConfigCliIO, line: string): void {
  ;(io.stdout ?? console.log)(line)
}

function cliErr(io: ConfigCliIO, line: string): void {
  ;(io.stderr ?? console.error)(line)
}

function cliExit(io: ConfigCliIO, code: number): void {
  ;(io.exit ?? process.exit)(code)
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function printConfigHelp(io: ConfigCliIO): void {
  cliOut(io, `Rivet Config Manager

Usage: rivet config <command>

Commands:
  show                         Show full config (JSON)
  providers                    List providers with key status
  setup <provider>             Create/update provider from built-in preset
  set-url <provider> <url>     Set provider base URL
  set-model <provider> <id>    Set preferred model for provider
  set-key <p> <key>            Set API key for provider
  set-key-env <p> <v>          Set API key from env variable
  set-default <p>              Set default provider
  set-approval <mode>          Set approval mode (auto-safe/manual/auto-accept/dangerously-skip-permissions)
  add-model <p> <id>           Add model to provider
  remove-model <p> <id>        Remove model from provider
  mcp                          MCP server management

Examples:
  rivet config providers
  rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default
  rivet config setup codex --default
  rivet config set-approval dangerously-skip-permissions
  rivet config set-url mimo https://token-plan-sgp.xiaomimimo.com/v1
  rivet config set-model minimax MiniMax-M2.8 300000 64000 m28
  rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp`)
}

export async function runConfigCLI(args: string[], io: ConfigCliIO = {}): Promise<void> {
  const cmd = args[0]
  try {
    if (!cmd) {
      const isTTY = io.isTTY ?? process.stdin.isTTY
      if (isTTY) {
        if (io.runWizard) await io.runWizard()
        else {
          const { runProviderConfigWizard } = await import('./provider-wizard.js')
          await runProviderConfigWizard({ write: line => cliOut(io, line) })
        }
        return
      }
      printConfigHelp(io)
      return
    }

    switch (cmd) {
      case 'show':
        cliOut(io, JSON.stringify(loadConfig(), null, 2))
        break

      case 'providers':
        cliOut(io, 'Providers:')
        for (const [name, p] of Object.entries(loadConfig().provider.providers)) {
          const marker = name === loadConfig().provider.default ? ' (default)' : ''
          const keyStatus = getApiKeyStatus(name)
          cliOut(io, `  ${name}${marker}`)
          cliOut(io, `    baseUrl: ${p.baseUrl}`)
          cliOut(io, `    apiKey: ${keyStatus.source === 'inline' ? keyStatus.ref : keyStatus.source === 'env' ? `${keyStatus.ref}` : '(not set)'}`)
          cliOut(io, `    models: ${p.models.map(m => m.alias ?? m.id).join(', ')}`)
        }
        break

      case 'setup': {
        const providerName = args[1]
        if (!providerName) {
          cliErr(io, 'Usage: rivet config setup <provider> [--key KEY|--key-env ENV] [--url URL] [--model ID --context-window N --max-tokens N] [--alias NAME] [--default]')
          cliExit(io, 1)
          return
        }
        const modelId = readFlag(args, '--model')
        const alias = readFlag(args, '--alias')
        // Preset-aware defaults: known models inherit their real context
        // window (e.g. deepseek-v4-pro = 1M). A silent 128K default on a
        // 1M model causes premature compaction tiers for the whole session.
        const presetModel = modelId ? findPresetModel(providerName, modelId) : undefined
        const cwFlag = readFlag(args, '--context-window')
        const mtFlag = readFlag(args, '--max-tokens')
        const model: ModelConfig | undefined = modelId
          ? {
              id: modelId,
              ...(alias ? { alias } : {}),
              contextWindow: cwFlag
                ? parsePositiveInt(cwFlag, 'context-window')
                : presetModel?.contextWindow ?? 128000,
              maxTokens: mtFlag
                ? parsePositiveInt(mtFlag, 'max-tokens')
                : presetModel?.maxTokens ?? 64000,
              ...(presetModel?.reasoningEffort ? { reasoningEffort: presetModel.reasoningEffort } : {}),
            }
          : undefined
        if (modelId && !cwFlag && !presetModel) {
          cliOut(io, `Warning: unknown model "${modelId}" — defaulting context window to 128000. Pass --context-window with the real value (compaction thresholds depend on it).`)
        }
        setupProvider({
          providerName,
          apiKey: readFlag(args, '--key'),
          apiKeyEnv: readFlag(args, '--key-env'),
          baseUrl: readFlag(args, '--url'),
          model,
          makeDefault: hasFlag(args, '--default'),
        })
        cliOut(io, `Provider ${providerName} configured${hasFlag(args, '--default') ? ' and set as default' : ''}`)
        break
      }

      case 'set-url': {
        const providerName = args[1]
        const baseUrl = args[2]
        if (!providerName || !baseUrl) {
          cliErr(io, 'Usage: rivet config set-url <provider> <base-url>')
          cliExit(io, 1)
          return
        }
        updateProviderBaseUrl(providerName, baseUrl)
        cliOut(io, `Base URL set for ${providerName}: ${baseUrl}`)
        break
      }

      case 'set-model': {
        const providerName = args[1]
        const modelId = args[2]
        if (!providerName || !modelId) {
          cliErr(io, 'Usage: rivet config set-model <provider> <model-id> [context-window] [max-tokens] [alias]')
          cliExit(io, 1)
          return
        }
        const alias = args[5]
        const presetModel = findPresetModel(providerName, modelId)
        const model: ModelConfig = {
          id: modelId,
          ...(alias ? { alias } : {}),
          contextWindow: args[3]
            ? parsePositiveInt(args[3], 'context-window')
            : presetModel?.contextWindow ?? 128000,
          maxTokens: args[4]
            ? parsePositiveInt(args[4], 'max-tokens')
            : presetModel?.maxTokens ?? 64000,
          ...(presetModel?.reasoningEffort ? { reasoningEffort: presetModel.reasoningEffort } : {}),
        }
        if (!args[3] && !presetModel) {
          cliOut(io, `Warning: unknown model "${modelId}" — defaulting context window to 128000. Pass an explicit context-window (compaction thresholds depend on it).`)
        }
        upsertProviderModel(providerName, model, { preferred: true })
        cliOut(io, `Preferred model for ${providerName} set to ${modelId}`)
        break
      }

      case 'set-key': {
        const providerName = args[1]
        const key = args[2]
        if (!providerName || !key) {
          cliErr(io, 'Usage: rivet config set-key <provider> <api-key>')
          cliExit(io, 1)
          return
        }
        setApiKey(providerName, key)
        cliOut(io, `API key set for ${providerName}`)
        break
      }

      case 'set-key-env': {
        const providerName = args[1]
        const envVar = args[2]
        if (!providerName || !envVar) {
          cliErr(io, 'Usage: rivet config set-key-env <provider> <ENV_VAR>')
          cliExit(io, 1)
          return
        }
        setApiKeyEnv(providerName, envVar)
        cliOut(io, `API key source set to ${envVar} for ${providerName}`)
        break
      }

      case 'set-default': {
        const providerName = args[1]
        if (!providerName) {
          cliErr(io, 'Usage: rivet config set-default <provider>')
          cliExit(io, 1)
          return
        }
        setDefaultProvider(providerName)
        cliOut(io, `Default provider set to ${providerName}`)
        break
      }

      case 'set-approval': {
        const mode = args[1]
        if (!mode) {
          cliErr(io, `Usage: rivet config set-approval <${APPROVAL_MODES.join('|')}>`)
          cliExit(io, 1)
          return
        }
        const saved = setApprovalMode(mode)
        cliOut(io, `Approval mode set to ${saved}`)
        break
      }

      case 'add-model': {
        const providerName = args[1]
        const modelId = args[2]
        const contextWindow = parseInt(args[3] ?? '1000000')
        const maxTokens = parseInt(args[4] ?? '64000')
        if (!providerName || !modelId) {
          cliErr(io, 'Usage: rivet config add-model <provider> <model-id> [context-window] [max-tokens]')
          cliExit(io, 1)
          return
        }
        addModel(providerName, { id: modelId, contextWindow, maxTokens })
        cliOut(io, `Model ${modelId} added to ${providerName}`)
        break
      }

      case 'remove-model': {
        const providerName = args[1]
        const modelId = args[2]
        if (!providerName || !modelId) {
          cliErr(io, 'Usage: rivet config remove-model <provider> <model-id>')
          cliExit(io, 1)
          return
        }
        removeModel(providerName, modelId)
        cliOut(io, `Model ${modelId} removed from ${providerName}`)
        break
      }

      case 'mcp': {
        const subcmd = args[1]
        if (subcmd === 'list') {
          const cfg = loadConfig()
          const servers = cfg.mcp?.servers ?? {}
          const entries = Object.entries(servers)
          if (entries.length === 0) {
            cliOut(io, 'No MCP servers configured.')
          } else {
            cliOut(io, 'MCP servers:')
            for (const [id, s] of entries) {
              const type = s.command ? `stdio: ${s.command}` : `sse: ${s.url}`
              const disabled = s.disabled ? ' (disabled)' : ''
              cliOut(io, `  ${id}: ${type}${disabled}`)
            }
          }
        } else if (subcmd === 'add-stdio') {
          const id = args[2]
          const command = args[3]
          const cmdArgs = args.slice(4)
          if (!id || !command) {
            cliErr(io, 'Usage: rivet config mcp add-stdio <id> <command> [args...]')
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          cfg.mcp.servers[id] = { command, args: cmdArgs.length > 0 ? cmdArgs : undefined }
          saveConfig(cfg)
          cliOut(io, `MCP server "${id}" added (stdio: ${command} ${cmdArgs.join(' ')}). Restart Rivet to connect.`)
        } else if (subcmd === 'add-sse') {
          const id = args[2]
          const url = args[3]
          if (!id || !url) {
            cliErr(io, 'Usage: rivet config mcp add-sse <id> <url>')
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          cfg.mcp.servers[id] = { url }
          saveConfig(cfg)
          cliOut(io, `MCP server "${id}" added (sse: ${url}). Restart Rivet to connect.`)
        } else if (subcmd === 'remove') {
          const id = args[2]
          if (!id) {
            cliErr(io, 'Usage: rivet config mcp remove <id>')
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          if (!cfg.mcp?.servers[id]) {
            cliErr(io, `MCP server "${id}" not found.`)
            cliExit(io, 1)
            return
          }
          delete cfg.mcp.servers[id]
          saveConfig(cfg)
          cliOut(io, `MCP server "${id}" removed. Restart Rivet to apply.`)
        } else if (subcmd === 'enable' || subcmd === 'disable') {
          const id = args[2]
          if (!id) {
            cliErr(io, `Usage: rivet config mcp ${subcmd} <id>`)
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          const server = cfg.mcp?.servers[id]
          if (!server) {
            cliErr(io, `MCP server "${id}" not found.`)
            cliExit(io, 1)
            return
          }
          server.disabled = subcmd === 'disable' ? true : undefined
          saveConfig(cfg)
          cliOut(io, `MCP server "${id}" ${subcmd}d. Restart Rivet to apply.`)
        } else {
          cliOut(io, `MCP server management:

Usage: rivet config mcp <command>

Commands:
  list                        List configured MCP servers
  add-stdio <id> <cmd> [args...]  Add a stdio MCP server
  add-sse <id> <url>          Add an SSE MCP server
  remove <id>                 Remove an MCP server
  enable <id>                 Enable an MCP server
  disable <id>                Disable an MCP server (keeps config)

Examples:
  rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp
  rivet config mcp add-sse ctx7 http://localhost:3001/sse
  rivet config mcp list
  rivet config mcp remove fs`)
        }
        break
      }

      default:
        printConfigHelp(io)
    }
  } catch (err) {
    cliErr(io, `Error: ${(err as Error).message}`)
    cliExit(io, 1)
  }
}
