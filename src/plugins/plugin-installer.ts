/**
 * Plugin installer — copy + npm install lifecycle for plugin packages.
 *
 * Supports local path sources (Wave 2). Npm package sources deferred.
 * Architecture decisions (per plan):
 *  - Install location: ~/.rivet/plugins/<name>/
 *  - npm install MUST use --ignore-scripts (no postinstall execution)
 *  - Installed plugins take effect next session (cache discipline)
 */

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { cpSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { rivetHome } from '../config/paths.js'
import { parseManifest, type PluginManifest, type PluginPackageJson } from './manifest.js'

// ── Types ──────────────────────────────────────────────────────────

export interface InstallSuccess {
  ok: true
  manifest: PluginManifest
  installPath: string
}

export interface InstallError {
  ok: false
  error: string
}

export type InstallResult = InstallSuccess | InstallError

export interface RemoveResult {
  ok: boolean
  error?: string
}

/** Lightweight metadata about an installed plugin (for /plugin list). */
export interface InstalledPluginInfo {
  name: string
  version: string
  description: string
  installPath: string
  entry: string
  toolCount: number
  toolNames: string[]
  tools: string
}

// ── Public API ─────────────────────────────────────────────────────

/** Get the plugins installation root directory. */
export function pluginsDir(): string {
  return join(rivetHome(), 'plugins')
}

/**
 * Install a plugin from a local directory path.
 *
 * Steps:
 *  1. Read and validate manifest from source directory
 *  2. Check for duplicate install
 *  3. Copy source tree to ~/.rivet/plugins/<name>/
 *  4. Run `npm install --ignore-scripts --omit=dev` inside
 *  5. Write install metadata
 */
export async function installPlugin(sourcePath: string): Promise<InstallResult> {
  // 1. Read package.json from source
  const srcPkgPath = join(sourcePath, 'package.json')
  let pkg: PluginPackageJson
  try {
    const raw = readFileSync(srcPkgPath, 'utf-8')
    pkg = JSON.parse(raw) as PluginPackageJson
  } catch {
    return { ok: false, error: `No valid package.json found at ${sourcePath}` }
  }

  const rawManifest = pkg.tianshu
  if (!rawManifest || typeof rawManifest !== 'object') {
    return { ok: false, error: 'No "tianshu" manifest field in package.json' }
  }

  const parseResult = parseManifest(rawManifest)
  if (!parseResult.ok) {
    return { ok: false, error: `Invalid manifest: ${parseResult.errors.join('; ')}` }
  }

  const manifest = parseResult.manifest
  const installPath = join(pluginsDir(), manifest.name)

  // 2. Check for duplicate
  if (existsSync(installPath)) {
    return { ok: false, error: `Plugin "${manifest.name}" is already installed. Use /plugin remove first.` }
  }

  // 3. Copy source tree
  try {
    mkdirSync(installPath, { recursive: true })
    cpSync(sourcePath, installPath, { recursive: true })
  } catch (err) {
    // Clean up partial copy
    try { rmSync(installPath, { recursive: true, force: true }) } catch {}
    return { ok: false, error: `Failed to copy plugin files: ${(err as Error).message}` }
  }

  // 4. Run npm install
  try {
    execSync('npm install --ignore-scripts --omit=dev', {
      cwd: installPath,
      stdio: 'pipe',
      timeout: 600_000, // 10 min for heavy deps
      env: { ...process.env, NODE_ENV: 'production' },
    })
  } catch (err) {
    // Clean up failed install
    try { rmSync(installPath, { recursive: true, force: true }) } catch {}
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().slice(0, 500) ?? (err as Error).message
    return { ok: false, error: `npm install failed: ${stderr}` }
  }

  return { ok: true, manifest, installPath }
}

/**
 * Check if a plugin is installed (directory exists with package.json).
 */
export function isPluginInstalled(name: string): boolean {
  const dir = join(pluginsDir(), name)
  return existsSync(join(dir, 'package.json'))
}

/**
 * List all installed plugins with their manifest info.
 */
export function getInstalledPlugins(): InstalledPluginInfo[] {
  const root = pluginsDir()
  if (!existsSync(root)) return []

  const results: InstalledPluginInfo[] = []
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)

    for (const name of entries) {
      const pkgPath = join(root, name, 'package.json')
      try {
        const raw = readFileSync(pkgPath, 'utf-8')
        const pkg = JSON.parse(raw) as PluginPackageJson
        if (pkg.tianshu && typeof pkg.tianshu === 'object') {
          const manifest = pkg.tianshu as Record<string, unknown>
          const tools = Array.isArray(manifest.tools) ? manifest.tools as Array<{ name: string }> : []
          results.push({
            name: (manifest.name as string) ?? name,
            version: (manifest.version as string) ?? 'unknown',
            description: (manifest.description as string) ?? '',
            entry: (manifest.entry as string) ?? '',
            installPath: join(root, name),
            toolCount: tools.length,
            toolNames: tools.map(t => t.name),
            tools: tools.map(t => t.name).join(', '),
          })
        }
      } catch {
        // Skip directories without readable package.json
      }
    }
  } catch {
    // best-effort listing
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Remove an installed plugin (deletes its directory).
 */
export function removePlugin(name: string): RemoveResult {
  const dir = join(pluginsDir(), name)
  if (!existsSync(dir)) {
    return { ok: false, error: `Plugin "${name}" is not installed.` }
  }

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `Failed to remove plugin: ${(err as Error).message}` }
  }

  return { ok: true }
}
