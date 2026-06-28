/**
 * /config/* routes — provider + API key management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /config/providers                list providers with key status
 *   POST   /config/providers                add/update a provider (setup flow)
 *   DELETE /config/providers/:name          remove a provider
 *   POST   /config/providers/:name/key      set API key (inline or env)
 *   POST   /config/providers/:name/default  set as default provider
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import {
  loadConfig,
  getApiKeyStatus,
  setupProvider,
  removeProvider,
  setDefaultProvider,
  setApiKey,
  setApiKeyEnv,
  getRoutingConfig,
  setRoutingConfig,
} from '../config/manager.js'
import { PROVIDER_PRESETS, providerPresetKeys, type ProviderPresetKey } from '../config/provider-presets.js'
import { modelConfigSchema, type ModelConfig } from '../config/schema.js'

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
  models: { id: string; alias?: string }[]
  isPreset: boolean
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
          models: p.models.map(m => ({ id: m.id, alias: m.alias, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
          isPreset: (providerPresetKeys as string[]).includes(name),
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
      const { providerName, apiKey, apiKeyEnv, baseUrl, makeDefault, model } = body as {
        providerName?: string
        apiKey?: string
        apiKeyEnv?: string
        baseUrl?: string
        makeDefault?: boolean
        model?: ModelConfig
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
        setupProvider({ providerName, apiKey, apiKeyEnv, baseUrl, model: parsedModel, makeDefault })
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
  }
}
