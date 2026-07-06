/**
 * /plugins/* routes — Plugin management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /plugins/presets        list plugin presets + installed state
 *   GET    /plugins/installed       list installed plugins with status
 *   POST   /plugins/install         install a plugin from local path
 *   POST   /plugins/enable          enable/disable a plugin by name
 *   DELETE /plugins/:name           remove an installed plugin
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig, saveConfig } from '../config/manager.js'
import { PLUGIN_PRESETS } from '../plugins/plugin-presets.js'
import { installPlugin, removePlugin, getInstalledPlugins, isPluginInstalled } from '../plugins/plugin-installer.js'
import { serverLogger } from './logger.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export function buildPluginRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    // GET /plugins/presets — curated plugin catalog + which are installed.
    'GET /plugins/presets': withAuth(() => {
      const installed = getInstalledPlugins()
      const installedNames = new Set(installed.map(p => p.name))
      const cfg = loadConfig()

      const presets = PLUGIN_PRESETS.map(p => ({
        ...p,
        installed: installedNames.has(p.id),
        enabled: cfg.plugins.enabled[p.id] !== false,
      }))

      return { status: 200, body: { presets } }
    }, apiToken),

    // GET /plugins/installed — installed plugins with details.
    'GET /plugins/installed': withAuth(() => {
      const installed = getInstalledPlugins()
      const cfg = loadConfig()
      const result = installed.map(p => ({
        ...p,
        enabled: cfg.plugins.enabled[p.name] !== false,
      }))
      return { status: 200, body: { plugins: result } }
    }, apiToken),

    // POST /plugins/install — install from local path.
    // Body: { path: string }
    'POST /plugins/install': withAuth(async (body) => {
      const input = body as { path?: string }
      if (!input.path || typeof input.path !== 'string') {
        return { status: 400, body: { error: 'Missing required field: path' } }
      }

      const result = await installPlugin(input.path)
      if (result.ok) {
        serverLogger.info({ msg: '[plugins] installed', name: result.manifest.name, path: input.path })
        return {
          status: 200,
          body: {
            ok: true,
            manifest: result.manifest,
            message: `Installed "${result.manifest.name}". Available on next session start.`,
          },
        }
      }
      return { status: 400, body: { ok: false, error: result.error } }
    }, apiToken),

    // POST /plugins/enable — enable or disable a plugin.
    // Body: { name: string, enabled: boolean }
    'POST /plugins/enable': withAuth((body) => {
      const input = body as { name?: string; enabled?: boolean }
      if (!input.name || typeof input.name !== 'string') {
        return { status: 400, body: { error: 'Missing required field: name' } }
      }
      if (typeof input.enabled !== 'boolean') {
        return { status: 400, body: { error: 'Missing required field: enabled (boolean)' } }
      }

      if (!isPluginInstalled(input.name)) {
        return { status: 404, body: { error: `Plugin "${input.name}" is not installed` } }
      }

      const cfg = loadConfig()
      cfg.plugins.enabled[input.name] = input.enabled
      saveConfig(cfg)

      serverLogger.info({ msg: '[plugins] toggled', name: input.name, enabled: input.enabled })
      return {
        status: 200,
        body: {
          ok: true,
          name: input.name,
          enabled: input.enabled,
          message: `Plugin "${input.name}" ${input.enabled ? 'enabled' : 'disabled'}. Takes effect on next session.`,
        },
      }
    }, apiToken),

    // DELETE /plugins/:name — remove an installed plugin.
    'DELETE /plugins/:name': withAuth((_body, params) => {
      const name = params?.name
      if (!name) {
        return { status: 400, body: { error: 'Missing plugin name in URL' } }
      }

      const result = removePlugin(name)
      if (result.ok) {
        serverLogger.info({ msg: '[plugins] removed', name })
        return { status: 200, body: { ok: true, message: `Removed plugin "${name}".` } }
      }
      return { status: 404, body: { ok: false, error: result.error } }
    }, apiToken),
  }
}
