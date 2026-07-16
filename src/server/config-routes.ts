/**
 * /config/* routes — provider + API key management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /config/providers                list providers with key status
 *   POST   /config/providers                add/update a provider (setup flow)
 *   POST   /config/providers/custom         create a new OpenAI-compatible provider from scratch
 *   DELETE /config/providers/:name          remove a provider
 *   DELETE /config/providers/:name/models/:modelId  remove a model from a provider
 *   POST   /config/providers/:name/key      set API key (inline or env)
 *   POST   /config/providers/:name/default  set as default provider
 *   GET    /config/balance                  query DeepSeek account balance (official API)
 *   GET    /config/autonomy                 autonomy brake mode + checkpoint interval (C3)
 *   PUT    /config/autonomy                 set autonomy brake mode / checkpoint interval (C3)
 *   GET    /config/computer-use             Computer Use status: platform, system permissions, app grants
 *   POST   /config/computer-use/revoke      revoke an app's "always allow" grant ({ app })
 *   GET    /config/permission-dirs          Codex-style standing directory grants (read/write, exists probe)
 *   PUT    /config/permission-dirs          set standing directory grants; additions apply immediately
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import {
  loadConfig,
  getApiKeyStatus,
  setupProvider,
  setupCustomProvider,
  removeProvider,
  removeModel,
  setDefaultProvider,
  setApiKey,
  setApiKeyEnv,
  setProviderAllowProFallback,
  getRoutingConfig,
  setRoutingConfig,
  getEditorConfig,
  setEditorConfig,
  getShellConfig,
  setShellConfig,
  getCheckpointConfig,
  setCheckpointConfig,
  getNetworkConfig,
  setNetworkConfig,
  getPermissionDirs,
  setPermissionDirs,
  getVisionModelConfig,
  setVisionModelConfig,
} from '../config/manager.js'
import { applyConfiguredPathGrants } from '../tools/path-grants.js'
import { expandHome } from '../platform.js'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { PROVIDER_PRESETS, providerPresetKeys, type ProviderPresetKey } from '../config/provider-presets.js'
import { modelConfigSchema, type ModelConfig } from '../config/schema.js'
import { queryDeepSeekBalance, type BalanceResult } from '../api/balance-client.js'
import { getDeepSeekUserSummary, getDeepSeekCostReport } from '../api/deepseek-platform-client.js'
import { listGrantedApps, revokeApp } from '../tools/computer-use/app-grants.js'
import { createPlatformDriver, isComputerUsePlatform } from '../tools/computer-use/platform-driver.js'
import { isProFeatureEnabled } from '../config/pro-license.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export interface ProviderListItem {
  name: string
  label: string
  baseUrl: string
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  models: { id: string; alias?: string; supportsVision?: boolean }[]
  isPreset: boolean
  allowProFallback: boolean
}

export function buildConfigRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /config/providers': withAuth(() => {
      const cfg = loadConfig()
      const defaultName = cfg.provider.default
      const providers: ProviderListItem[] = []

      for (const [name, p] of Object.entries(cfg.provider.providers)) {
        providers.push({
          name,
          label: (providerPresetKeys as string[]).includes(name)
            ? PROVIDER_PRESETS[name as ProviderPresetKey].label
            : name,
          baseUrl: p.baseUrl,
          isDefault: name === defaultName,
          keyStatus: getApiKeyStatus(name),
          models: p.models.map(m => ({ id: m.id, alias: m.alias, contextWindow: m.contextWindow, maxTokens: m.maxTokens, supportsVision: m.supportsVision })),
          isPreset: (providerPresetKeys as string[]).includes(name),
          allowProFallback: p.allowProFallback ?? false,
        })
      }

      const unconfigured = providerPresetKeys
        .filter(k => !cfg.provider.providers[k])
        .map(k => ({
          key: k,
          label: PROVIDER_PRESETS[k].label,
          defaultModelId: PROVIDER_PRESETS[k].defaultModelId,
        }))

      return { status: 200, body: { providers, unconfigured } }
    }, apiToken),

    'POST /config/providers': withAuth((body) => {
      const { providerName, apiKey, apiKeyEnv, baseUrl, makeDefault, model, allowProFallback } = body as {
        providerName?: string
        apiKey?: string
        apiKeyEnv?: string
        baseUrl?: string
        makeDefault?: boolean
        model?: ModelConfig
        allowProFallback?: boolean
      }
      if (!providerName) return { status: 400, body: { error: 'providerName is required' } }

      let parsedModel: ModelConfig | undefined
      if (model) {
        const result = modelConfigSchema.safeParse(model)
        if (!result.success) {
          return { status: 400, body: { error: `Invalid model: ${result.error.message}` } }
        }
        parsedModel = result.data
      }

      try {
        setupProvider({ providerName, apiKey, apiKeyEnv, baseUrl, model: parsedModel, makeDefault, allowProFallback })
        return { status: 200, body: { ok: true, providerName } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/providers/custom': withAuth((body) => {
      // 凭空创建一个 OpenAI 兼容 provider（不依赖预设）——支持 Ollama/vLLM/
      // OpenAI 直连/第三方兼容端点。与 setupProvider 区别：后者要求 providerName
      // 在预设或已存在，本端点从零 materialize 一个完整 ProviderConfig。
      const { providerName, apiKey, baseUrl, makeDefault, model, allowProFallback } = body as {
        providerName?: string
        apiKey?: string
        baseUrl?: string
        makeDefault?: boolean
        model?: ModelConfig
        allowProFallback?: boolean
      }
      if (!providerName) return { status: 400, body: { error: 'providerName is required' } }
      if (!baseUrl) return { status: 400, body: { error: 'baseUrl is required' } }
      if (!model) return { status: 400, body: { error: 'model is required' } }

      const result = modelConfigSchema.safeParse(model)
      if (!result.success) {
        return { status: 400, body: { error: `Invalid model: ${result.error.message}` } }
      }

      try {
        setupCustomProvider({
          providerName,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          model: result.data,
          makeDefault,
          allowProFallback,
        })
        return { status: 200, body: { ok: true, providerName } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/providers/:name': withAuth((_body, params) => {
      const name = params?.name
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      try {
        removeProvider(name)
        return { status: 200, body: { ok: true, removed: name } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/providers/:name/models/:modelId': withAuth((_body, params) => {
      const name = params?.name
      const modelId = params?.modelId
      if (!name || !modelId) return { status: 400, body: { error: 'provider name and modelId are required' } }
      try {
        removeModel(name, modelId)
        return { status: 200, body: { ok: true, removed: modelId } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/providers/:name/key': withAuth((body, params) => {
      const name = params?.name
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const { apiKey, apiKeyEnv: envVar } = body as { apiKey?: string; apiKeyEnv?: string }
      try {
        if (apiKey) setApiKey(name, apiKey)
        else if (envVar) setApiKeyEnv(name, envVar)
        else return { status: 400, body: { error: 'apiKey or apiKeyEnv required' } }
        return { status: 200, body: { ok: true, keyStatus: getApiKeyStatus(name) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/providers/:name/default': withAuth((_body, params) => {
      const name = params?.name
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      try {
        setDefaultProvider(name)
        return { status: 200, body: { ok: true, default: name } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'PUT /config/providers/:name/allow-pro-fallback': withAuth((body, params) => {
      const name = params?.name
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const { allowProFallback } = (body ?? {}) as { allowProFallback?: unknown }
      if (typeof allowProFallback !== 'boolean') {
        return { status: 400, body: { error: 'allowProFallback boolean is required' } }
      }
      try {
        setProviderAllowProFallback(name, allowProFallback)
        return { status: 200, body: { ok: true, allowProFallback } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Sub-agent / review model routing (agent.review + workers blocks).
    'GET /config/routing': withAuth(() => {
      return { status: 200, body: getRoutingConfig() }
    }, apiToken),

    'PUT /config/routing': withAuth((body) => {
      const { review, workers, council } = (body ?? {}) as { review?: unknown; workers?: unknown; council?: unknown }
      if (review === undefined && workers === undefined && council === undefined) {
        return { status: 400, body: { error: 'review, workers or council is required' } }
      }
      try {
        const result = setRoutingConfig({ review, workers, council })
        return { status: 200, body: { ok: true, ...result } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'GET /config/editor': withAuth(() => {
      return { status: 200, body: getEditorConfig() }
    }, apiToken),

    'PUT /config/editor': withAuth((body) => {
      const { platform, eol } = (body ?? {}) as { platform?: unknown; eol?: unknown }
      if (platform === undefined && eol === undefined) {
        return { status: 400, body: { error: 'platform or eol is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setEditorConfig({ platform, eol }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Windows Git Bash override + cross-platform git executable override for the
    // desktop settings UI. `exists` lets the UI warn about a stale/typo'd path
    // without blocking the save. Takes effect on the next sidecar restart.
    'GET /config/shell': withAuth(() => {
      const cfg = getShellConfig()
      return {
        status: 200,
        body: {
          ...cfg,
          exists: cfg.gitBashPath ? existsSync(cfg.gitBashPath) : null,
          gitExists: cfg.gitPath ? existsSync(cfg.gitPath) : null,
        },
      }
    }, apiToken),

    'PUT /config/shell': withAuth((body) => {
      const { gitBashPath, gitPath } = (body ?? {}) as { gitBashPath?: unknown; gitPath?: unknown }
      if (gitBashPath === undefined && gitPath === undefined) {
        return { status: 400, body: { error: 'gitBashPath or gitPath is required' } }
      }
      try {
        const next = setShellConfig({ gitBashPath, gitPath })
        return {
          status: 200,
          body: {
            ok: true,
            ...next,
            exists: next.gitBashPath ? existsSync(next.gitBashPath) : null,
            gitExists: next.gitPath ? existsSync(next.gitPath) : null,
          },
        }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // C3 — Auto mode checkpoint interval for the desktop/TUI settings UI.
    'GET /config/checkpoint': withAuth(() => {
      return { status: 200, body: getCheckpointConfig() }
    }, apiToken),

    'PUT /config/checkpoint': withAuth((body) => {
      const { checkpointEveryTurns } = (body ?? {}) as {
        checkpointEveryTurns?: unknown
      }
      if (checkpointEveryTurns === undefined) {
        return { status: 400, body: { error: 'checkpointEveryTurns is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setCheckpointConfig({ checkpointEveryTurns }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // HTTP proxy for web_fetch / import_resource (Clash etc.). Empty = follow env.
    'GET /config/network': withAuth(() => {
      return { status: 200, body: getNetworkConfig() }
    }, apiToken),

    'PUT /config/network': withAuth((body) => {
      const { proxy, noProxy } = (body ?? {}) as { proxy?: unknown; noProxy?: unknown }
      if (proxy === undefined && noProxy === undefined) {
        return { status: 400, body: { error: 'proxy or noProxy is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setNetworkConfig({ proxy, noProxy }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Computer Use (desktop GUI automation) status for the desktop settings UI:
    // platform availability, Pro gating, system permission probe, and per-app grants.
    'GET /config/computer-use': withAuth(async () => {
      const cfg = loadConfig()
      const platformOk = isComputerUsePlatform(process.platform) && process.env.RIVET_COMPUTER_USE !== '0'
      const proEnabled = isProFeatureEnabled(cfg, 'computerUse')
      const proRequired = platformOk && !proEnabled
      const available = platformOk && proEnabled
      const grants = listGrantedApps().map(g => ({ app: g.app, grantedAt: g.grantedAt }))
      if (!available) {
        return { status: 200, body: { available: false, proRequired, platform: process.platform, permissions: null, grants } }
      }
      let permissions: { accessibility: boolean; screenRecording: boolean; detail: string } | null = null
      try {
        permissions = await createPlatformDriver().checkPermissions()
      } catch { /* probe failure → permissions unknown, UI shows a hint */ }
      return { status: 200, body: { available: true, proRequired: false, platform: process.platform, permissions, grants } }
    }, apiToken),

    // Codex-style standing directory grants for the desktop settings UI.
    // `exists` lets the UI warn about missing/typo'd paths without blocking the
    // save — applyConfiguredPathGrants skips non-existent entries fail-closed.
    'GET /config/permission-dirs': withAuth(() => {
      const dirs = getPermissionDirs()
      const probe = (p: string) => ({ path: p, exists: existsSync(resolve(expandHome(p))) })
      return {
        status: 200,
        body: {
          readDirs: dirs.additionalReadDirs.map(probe),
          writeDirs: dirs.additionalWriteDirs.map(probe),
        },
      }
    }, apiToken),

    'PUT /config/permission-dirs': withAuth((body) => {
      const { additionalReadDirs, additionalWriteDirs } = (body ?? {}) as {
        additionalReadDirs?: unknown
        additionalWriteDirs?: unknown
      }
      if (additionalReadDirs === undefined && additionalWriteDirs === undefined) {
        return { status: 400, body: { error: 'additionalReadDirs or additionalWriteDirs is required' } }
      }
      try {
        const before = getPermissionDirs()
        const next = setPermissionDirs({ additionalReadDirs, additionalWriteDirs })
        // Additions take effect immediately in this running sidecar (in-memory
        // grants for every live session). Removals cannot be revoked from the
        // in-memory store — the same root may also hold an approval-time grant —
        // so a removed entry stays effective until the next sidecar start.
        applyConfiguredPathGrants(next)
        const removed = [
          ...before.additionalReadDirs.filter(d => !next.additionalReadDirs.includes(d)),
          ...before.additionalWriteDirs.filter(d => !next.additionalWriteDirs.includes(d)),
        ]
        const probe = (p: string) => ({ path: p, exists: existsSync(resolve(expandHome(p))) })
        return {
          status: 200,
          body: {
            ok: true,
            readDirs: next.additionalReadDirs.map(probe),
            writeDirs: next.additionalWriteDirs.map(probe),
            restartRequired: removed.length > 0,
          },
        }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Revoke an app's "always allow" grant. App name in body (may contain
    // spaces/unicode — avoids URL-encoding pitfalls in path params).
    'POST /config/computer-use/revoke': withAuth((body) => {
      const { app } = (body ?? {}) as { app?: unknown }
      if (typeof app !== 'string' || !app.trim()) {
        return { status: 400, body: { error: 'app is required' } }
      }
      const removed = revokeApp(app.trim())
      if (!removed) return { status: 404, body: { error: `No grant found for "${app.trim()}"` } }
      return { status: 200, body: { ok: true, grants: listGrantedApps().map(g => ({ app: g.app, grantedAt: g.grantedAt })) } }
    }, apiToken),

    // Vision bridge model: optional multimodal model used to describe images
    // when the primary model is not vision-capable.
    'GET /config/vision-model': withAuth(() => {
      return { status: 200, body: { config: getVisionModelConfig() } }
    }, apiToken),

    'PUT /config/vision-model': withAuth((body) => {
      const { config } = (body ?? {}) as { config?: unknown }
      try {
        const saved = setVisionModelConfig(config as Record<string, unknown> | null)
        return { status: 200, body: { ok: true, config: saved } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'GET /config/balance': withAuth(async () => {
      // 查 DeepSeek 官方账户余额。仅 DeepSeek 官方端点支持（其他 provider 返回 null）。
      const cfg = loadConfig()
      const provider = cfg.provider.providers[cfg.provider.default]
      if (!provider) return { status: 200, body: { balance: null as BalanceResult | null } }
      const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      const balance = await queryDeepSeekBalance(apiKey, provider.baseUrl)
      return { status: 200, body: { balance } }
    }, apiToken),

    // DeepSeek 平台账户摘要：当天/当月花费、余额、Flash/Pro 用量。
    'GET /config/deepseek/summary': withAuth(async () => {
      const cfg = loadConfig()
      const provider = cfg.provider.providers[cfg.provider.default]
      if (!provider) return { status: 200, body: { summary: null } }
      const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      const summary = await getDeepSeekUserSummary(apiKey, provider.baseUrl)
      return { status: 200, body: { summary } }
    }, apiToken),

    // DeepSeek 平台成本明细：按模型按天的 token/cost。month=1-12, year=YYYY。
    'GET /config/deepseek/cost': withAuth(async (_body, params) => {
      const cfg = loadConfig()
      const provider = cfg.provider.providers[cfg.provider.default]
      if (!provider) return { status: 200, body: { cost: null } }
      const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      const now = new Date()
      const month = Number(params?.month ?? now.getMonth() + 1)
      const year = Number(params?.year ?? now.getFullYear())
      const cost = await getDeepSeekCostReport(apiKey, provider.baseUrl, month, year)
      return { status: 200, body: { cost } }
    }, apiToken),
  }
}
