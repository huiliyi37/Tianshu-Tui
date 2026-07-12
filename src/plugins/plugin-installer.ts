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
import { join, basename, dirname } from 'node:path'
import { cpSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { rivetHome } from '../config/paths.js'
import { parseManifest, type PluginManifest, type PluginPackageJson } from './manifest.js'

// ── npm resolution ─────────────────────────────────────────────────

/**
 * Resolve the npm command to use for plugin installs.
 *
 * The packaged desktop app bundles its own Node runtime (and now npm) under
 * `node-runtime/<os>-<arch>/`. When the sidecar is hosted by that runtime,
 * npm lives right next to the Node binary and we should use it so users do
 * not need a system Node/npm install.
 *
 * Falls back to the system `npm` command in dev / test environments where the
 * bundled npm is absent.
 */
function resolveNpmCommand(): string {
  const nodeBin = process.execPath
  const nodeDir = dirname(nodeBin)
  const isWindows = process.platform === 'win32'

  // Bundled npm layout mirrors the official Node.js archive layout.
  const candidates = isWindows
    ? [join(nodeDir, 'npm.cmd'), join(nodeDir, 'npm')]
    : [join(nodeDir, 'bin', 'npm')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return isWindows ? 'npm.cmd' : 'npm'
}

/**
 * Build the platform-aware shell invocation for npm install.
 *
 * Windows: `npm` is a `.cmd` script; Node's execSync needs `shell: true` to
 * resolve it. We also quote the npm path to handle spaces.
 *
 * Unix: execute the npm script directly (bundled) or via PATH fallback.
 */
function npmInstallArgs(cmd: string): { command: string; options: import('node:child_process').ExecSyncOptions } {
  const baseArgs = ['install', '--ignore-scripts', '--omit=dev']
  const isWindows = process.platform === 'win32'

  // Make sure the Node binary hosting this sidecar is on PATH before npm runs.
  // The packaged desktop app bundles its own Node/npm; npm's launcher script
  // resolves `node` via PATH, so without this it could pick up a system Node
  // (or none at all) and fail or use the wrong ABI.
  const nodeDir = dirname(process.execPath)
  const pathSep = isWindows ? ';' : ':'
  const currentPath = process.env.PATH || ''
  const pathWithNode = currentPath ? `${nodeDir}${pathSep}${currentPath}` : nodeDir

  const options: import('node:child_process').ExecSyncOptions = {
    stdio: 'pipe',
    timeout: 600_000,
    env: { ...process.env, NODE_ENV: 'production', PATH: pathWithNode },
  }

  if (isWindows) {
    // ExecSyncOptions.shell is typed as string in this @types/node version,
    // but the runtime accepts boolean. Use cmd.exe explicitly to satisfy TS.
    options.shell = process.env.ComSpec || 'cmd.exe'
    return { command: `"${cmd}" ${baseArgs.join(' ')}`, options }
  }

  return { command: `${cmd} ${baseArgs.join(' ')}`, options }
}

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

  // 4. Run npm install using the bundled npm when available (packaged desktop
  // app) or the system npm as a fallback (dev / tests).
  const npmCmd = resolveNpmCommand()
  const { command, options } = npmInstallArgs(npmCmd)
  try {
    execSync(command, {
      ...options,
      cwd: installPath,
    })
  } catch (err) {
    // Clean up failed install
    try { rmSync(installPath, { recursive: true, force: true }) } catch {}
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().slice(0, 500) ?? (err as Error).message
    return { ok: false, error: `npm install failed (${npmCmd}): ${stderr}` }
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
