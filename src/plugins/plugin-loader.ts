/**
 * Plugin loader — scans ~/.rivet/plugins/, validates manifests, dynamically
 * imports entry modules, and registers tools into the tool registry.
 *
 * Architecture decisions (per plan):
 *  - Entry: compiled JS file path relative to plugin root (方案 A).
 *  - Loading: async dynamic import, call during session startup alongside MCP init.
 *  - Failure isolation: single plugin failure → skip + warning, never block startup.
 *  - Conflict detection: plugin tool names vs registry → reject plugin, log conflict details.
 *  - Cache discipline: tools are registered during startup ONLY; mid-session
 *    install/enable takes effect next session.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { parseManifest, type PluginManifest, type PluginPackageJson } from './manifest.js'

// ── Types ──────────────────────────────────────────────────────────

export interface PluginLoadResult {
  pluginName: string
  status: 'loaded' | 'skipped_disabled' | 'skipped_no_manifest' | 'skipped_invalid_manifest' | 'skipped_no_entry' | 'skipped_import_error' | 'skipped_conflict' | 'skipped_no_tools'
  toolCount?: number
  error?: string
}

export interface PluginsInitResult {
  scanned: number
  loaded: number
  skipped: number
  totalTools: number
  results: PluginLoadResult[]
  warnings: string[]
  /** Built-in tool names to suppress because a plugin has taken over. */
  suppressTools: string[]
}

/** Minimal config subset needed by the plugin loader. */
export interface PluginConfig {
  enabled?: Record<string, boolean>
}

/**
 * When a plugin loads successfully, remove these built-in tool names from the
 * registry. This is the "让位" (surrender) mechanism — plugins replace HTML
 * fallback tools with native format tools.
 *
 * Key: plugin name. Value: built-in tool names to suppress.
 */
export const PLUGIN_TOOL_SUPPRESS_MAP: Record<string, string[]> = {
  'office-pdf': ['create_pdf'],
  'office-excel': ['create_spreadsheet'],
  'office-ppt': ['create_presentation'],
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Initialize plugins: scan, validate, load, and register tools.
 *
 * @param pluginConfig - Config.plugins (enabled state). If undefined, all installed plugins are enabled.
 * @param toolRegistry - The ToolRegistry to register plugin tools into.
 * @returns Structured result with per-plugin status and summary.
 */
export async function initializePlugins(
  pluginConfig: PluginConfig | undefined,
  toolRegistry: ToolRegistry,
): Promise<PluginsInitResult> {
  const pluginsDir = join(rivetHome(), 'plugins')
  const warnings: string[] = []
  const results: PluginLoadResult[] = []

  if (!existsSync(pluginsDir)) {
    return { scanned: 0, loaded: 0, skipped: 0, totalTools: 0, results, warnings, suppressTools: [] }
  }

  let entries: string[]
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    warnings.push(`[plugins] Cannot read plugins directory: ${pluginsDir}`)
    return { scanned: 0, loaded: 0, skipped: 0, totalTools: 0, results, warnings, suppressTools: [] }
  }

  const enabled = pluginConfig?.enabled ?? {}

  for (const dirName of entries) {
    const result = await loadOnePlugin(dirName, pluginsDir, enabled, toolRegistry)
    results.push(result)
    if (result.error) {
      warnings.push(`[plugins] ${result.pluginName}: ${result.error}`)
    }
  }

  const loaded = results.filter(r => r.status === 'loaded')
  const totalTools = loaded.reduce((sum, r) => sum + (r.toolCount ?? 0), 0)
  const suppressTools = loaded.flatMap(r => PLUGIN_TOOL_SUPPRESS_MAP[r.pluginName] ?? [])

  return {
    scanned: entries.length,
    loaded: loaded.length,
    skipped: results.length - loaded.length,
    totalTools,
    results,
    warnings,
    suppressTools,
  }
}

// ── Per-plugin loading ─────────────────────────────────────────────

async function loadOnePlugin(
  dirName: string,
  pluginsDir: string,
  enabled: Record<string, boolean>,
  registry: ToolRegistry,
): Promise<PluginLoadResult> {
  const pluginDir = join(pluginsDir, dirName)
  const pkgPath = join(pluginDir, 'package.json')

  // 1. Read package.json
  let pkg: PluginPackageJson
  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    pkg = JSON.parse(raw) as PluginPackageJson
  } catch {
    return { pluginName: dirName, status: 'skipped_no_manifest', error: 'Cannot read package.json' }
  }

  // 2. Extract and validate manifest
  const rawManifest = pkg.tianshu
  if (!rawManifest || typeof rawManifest !== 'object') {
    return { pluginName: dirName, status: 'skipped_no_manifest', error: 'No "tianshu" field in package.json' }
  }

  const parseResult = parseManifest(rawManifest)
  if (!parseResult.ok) {
    return {
      pluginName: rawManifest.name && typeof rawManifest.name === 'string' ? rawManifest.name : dirName,
      status: 'skipped_invalid_manifest',
      error: `Invalid manifest: ${parseResult.errors.join('; ')}`,
    }
  }

  const manifest: PluginManifest = parseResult.manifest

  // 3. Check enabled state (default: enabled)
  if (enabled[manifest.name] === false) {
    return { pluginName: manifest.name, status: 'skipped_disabled' }
  }

  // 4. Resolve entry path
  const entryPath = join(pluginDir, manifest.entry)

  // 5. Dynamic import — WARNING: executes plugin code in-process
  let pluginModule: unknown
  try {
    pluginModule = await import(entryPath)
  } catch (err) {
    return {
      pluginName: manifest.name,
      status: 'skipped_import_error',
      error: `Cannot import entry "${manifest.entry}": ${(err as Error).message}`,
    }
  }

  // 6. Extract tools — the module must export `tools: Tool[]`
  const mod = pluginModule as Record<string, unknown>
  const tools: Tool[] | undefined = Array.isArray(mod.tools) ? mod.tools as Tool[] : undefined

  if (!tools || tools.length === 0) {
    return {
      pluginName: manifest.name,
      status: 'skipped_no_tools',
      error: 'Plugin module exports no "tools" array',
    }
  }

  // 7. Conflict detection — reject entire plugin if any tool name collides
  const existingNames = new Set(registry.getAllNames())
  const conflicts: string[] = []
  for (const tool of tools) {
    if (existingNames.has(tool.definition.name)) {
      conflicts.push(tool.definition.name)
    }
  }
  if (conflicts.length > 0) {
    return {
      pluginName: manifest.name,
      status: 'skipped_conflict',
      error: `Tool name conflicts with existing registry entries: ${conflicts.join(', ')}`,
    }
  }

  // 8. Register
  for (const tool of tools) {
    registry.register(tool)
  }

  return { pluginName: manifest.name, status: 'loaded', toolCount: tools.length }
}
