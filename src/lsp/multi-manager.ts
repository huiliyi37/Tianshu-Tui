/**
 * Multi-language LSP manager.
 *
 * Wraps the single-server `createLspManager` and routes each request to the
 * language server matching the file's extension, lazily spawning + initializing
 * each server on first use. This gives polyglot go-to-definition / diagnostics
 * (pyright / gopls / rust-analyzer / clangd / jdtls / typescript-language-server)
 * behind the existing single `LspManager` interface, so the late-bound
 * `getLspManager()` getter and all call sites are unchanged.
 */

import type { ChildProcess } from 'node:child_process'
import { spawnHidden } from '../tools/spawn-hidden.js'
import {
  resolveNpmCliCommand,
  buildStdioEnvWithNodePath,
  type ResolveNodeCliDeps,
} from '../platform/resolve-node-cli.js'
import { createLspManager, type LspManager, type LspDiagnostic } from './manager.js'
import {
  serverForFile,
  availableServers,
  defaultWhich,
  type LspServerDef,
  type WhichFn,
} from './server-registry.js'

interface Location {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface MultiLspOptions {
  which?: WhichFn
  /** Injected for tests; defaults to a real child-process spawn. */
  spawnFor?: (def: LspServerDef, cwd: string) => ChildProcess
}

type LspSpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess

/**
 * Default spawn for LSP servers: rewrites bare npx/npm to node+cli.js so
 * Windows GUI / bundled-node launches don't ENOENT on npx.cmd when shell is
 * forced off (spawnHidden). Non-npx commands pass through unchanged.
 *
 * `resolveDeps` / `spawnFn` are injectable so tests can simulate the desktop
 * bundled node-runtime layout without depending on the host Node install.
 */
export function defaultLspSpawn(
  def: LspServerDef,
  cwd: string,
  spawnFn: LspSpawnFn = spawnHidden as LspSpawnFn,
  resolveDeps: ResolveNodeCliDeps = {},
): ChildProcess {
  const resolved = resolveNpmCliCommand(def.command, def.args ?? [], resolveDeps)
  const env = buildStdioEnvWithNodePath(undefined, {
    ...resolveDeps,
    getDefaultEnvironment: () => ({ ...process.env } as Record<string, string>),
  })
  return spawnFn(resolved.command, resolved.args, {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], env,
  })
}

export function createMultiLspManager(cwd: string, opts: MultiLspOptions = {}): LspManager {
  const which = opts.which ?? defaultWhich
  const spawnFor = opts.spawnFor ?? ((def, c) => defaultLspSpawn(def, c))

  const managers = new Map<string, { mgr: LspManager; ready: Promise<void> }>()
  let availableCache: LspServerDef[] | null = null

  const getAvailable = (): LspServerDef[] => {
    if (availableCache === null) availableCache = availableServers(which)
    return availableCache
  }

  const ensure = async (def: LspServerDef): Promise<LspManager | null> => {
    let entry = managers.get(def.id)
    if (!entry) {
      const mgr = createLspManager(() => spawnFor(def, cwd), cwd)
      const ready = mgr.initialize().catch(() => { /* server unavailable */ })
      entry = { mgr, ready }
      managers.set(def.id, entry)
    }
    await entry.ready
    return entry.mgr.isReady() ? entry.mgr : null
  }

  const resolve = (filePath: string): LspServerDef | null => serverForFile(filePath, which)

  return {
    async initialize(): Promise<void> {
      // Lazy: servers spawn on first matching file. Nothing to do eagerly.
    },
    isReady(): boolean {
      // Ready when at least one server is installed; per-file readiness is
      // resolved at call time.
      return getAvailable().length > 0
    },
    supportsDefinition(): boolean {
      return getAvailable().length > 0
    },
    supportsReferences(): boolean {
      return getAvailable().length > 0
    },
    async gotoDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
      const def = resolve(filePath)
      if (!def) return []
      const mgr = await ensure(def)
      return mgr ? mgr.gotoDefinition(filePath, line, character) : []
    },
    async findReferences(filePath: string, line: number, character: number): Promise<Location[]> {
      const def = resolve(filePath)
      if (!def) return []
      const mgr = await ensure(def)
      return mgr ? mgr.findReferences(filePath, line, character) : []
    },
    changeFile(filePath: string): void {
      const def = resolve(filePath)
      if (!def) return
      void ensure(def).then(mgr => mgr?.changeFile(filePath)).catch(() => { /* best-effort */ })
    },
    async getFileDiagnostics(filePath: string, timeoutMs?: number): Promise<LspDiagnostic[]> {
      const def = resolve(filePath)
      if (!def) return []
      const mgr = await ensure(def)
      return mgr ? mgr.getFileDiagnostics(filePath, timeoutMs) : []
    },
    dispose(): void {
      for (const { mgr } of managers.values()) {
        try { mgr.dispose() } catch { /* best-effort */ }
      }
      managers.clear()
    },
  }
}
