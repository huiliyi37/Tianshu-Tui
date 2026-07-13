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
import { parseManifest } from '../plugins/manifest.js'
import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute, dirname, sep, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The project root in dev: the parent of dist/ (where main.js is emitted).
 * Packaged installs resolve first-party presets via `bundledPluginsDir()` —
 * `projectRoot()` alone lands on the install root (tsup flat chunks → three
 * dirnames), which does not contain `plugins/`.
 */
function projectRoot(): string {
  // In dev, process.env.RIVET_SIDECAR_ENTRY points to repo's dist/main.js.
  const entry = process.env.RIVET_SIDECAR_ENTRY
  if (entry) return dirname(dirname(entry))
  // Otherwise: module lives under dist/ (or a flat chunk next to main.js);
  // project root is parent of dist/.
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

/**
 * Locate the packaged `plugins/` tree shipped beside `rivet-runtime/`
 * (tauri maps `resources/plugins-staged` → `plugins`). Prefer the explicit
 * override from the desktop shell; fall back to siblings of this module.
 */
export function bundledPluginsDir(): string | null {
  const override = process.env.RIVET_BUNDLED_PLUGINS_DIR
  if (override) {
    try {
      if (existsSync(override)) return override
    } catch {
      /* fall through */
    }
  }
  let base: string
  try {
    base = dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
  // Packaged: rivet-runtime/{main,chunk-*.js} → ../plugins
  // Nested chunk layout (if any) → ../../plugins
  for (const candidate of [
    join(base, '..', 'plugins'),
    join(base, '..', '..', 'plugins'),
  ]) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Resolve a possibly-relative plugin source path to an absolute path.
 * Relative paths prefer the repo project root (dev); packaged presets under
 * `plugins/<id>` fall back to the bundled resources tree.
 */
export function resolveSourcePath(inputPath: string): string {
  if (isAbsolute(inputPath)) return inputPath
  const fromRoot = join(projectRoot(), inputPath)
  if (existsSync(fromRoot)) return fromRoot

  const normalized = normalize(inputPath)
  const pluginsPrefix = `plugins${sep}`
  const pluginsPrefixPosix = 'plugins/'
  if (
    normalized === 'plugins'
    || normalized.startsWith(pluginsPrefix)
    || normalized.startsWith(pluginsPrefixPosix)
  ) {
    const bundled = bundledPluginsDir()
    if (bundled) {
      const rest = normalized === 'plugins'
        ? ''
        : normalized.slice(normalized.startsWith(pluginsPrefix) ? pluginsPrefix.length : pluginsPrefixPosix.length)
      const candidate = rest ? join(bundled, rest) : bundled
      if (existsSync(candidate)) return candidate
    }
  }
  return fromRoot
}

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

      // enabled is only meaningful for installed plugins — the config default
      // ("absent means enabled") must not leak `enabled: true` for plugins
      // that are not even installed (confuses the settings UI).
      const presets = PLUGIN_PRESETS.map(p => {
        const installed = installedNames.has(p.id)
        return {
          ...p,
          installed,
          enabled: installed && cfg.plugins.enabled[p.id] !== false,
        }
      })

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
    // Body: { path: string, confirm: boolean }
    // Pre-flight: reads manifest BEFORE install, requires confirm:true to proceed.
    // Without confirm, returns manifest + permissions for caller-side review.
    'POST /plugins/install': withAuth(async (body) => {
      const input = body as { path?: string; confirm?: boolean }
      if (!input.path || typeof input.path !== 'string') {
        return { status: 400, body: { error: 'Missing required field: path' } }
      }

      // Pre-flight: read manifest from source to show permissions before installing
      const sourcePath = resolveSourcePath(input.path)
      const pkgPath = join(sourcePath, 'package.json')
      if (!existsSync(pkgPath)) {
        return { status: 400, body: { ok: false, error: `No package.json found at ${sourcePath}` } }
      }
      let manifest: Record<string, unknown> | undefined
      try {
        const raw = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        if (raw.tianshu && typeof raw.tianshu === 'object') {
          const parsed = parseManifest(raw.tianshu)
          if (parsed.ok) {
            manifest = parsed.manifest as unknown as Record<string, unknown>
          } else {
            return { status: 400, body: { ok: false, error: `Invalid plugin manifest: ${parsed.errors.join('; ')}` } }
          }
        }
      } catch {
        return { status: 400, body: { ok: false, error: 'Cannot parse package.json' } }
      }
      // Not a plugin at all (no tianshu manifest) — reject up front instead of
      // returning a misleading "Confirmation required" with an empty manifest.
      if (!manifest) {
        return { status: 400, body: { ok: false, error: `No "tianshu" manifest field in package.json at ${input.path} — not a Tianshu plugin.` } }
      }

      if (!input.confirm) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'Confirmation required. Review the manifest and permissions, then retry with confirm: true.',
            manifest,
            hint: 'Set confirm: true to proceed with installation.',
          },
        }
      }

      const result = await installPlugin(sourcePath)
      if (result.ok) {
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
        return { status: 200, body: { ok: true, message: `Removed plugin "${name}".` } }
      }
      return { status: 404, body: { ok: false, error: result.error } }
    }, apiToken),
  }
}
