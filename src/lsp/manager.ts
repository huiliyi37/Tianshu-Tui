import type { ChildProcess } from 'node:child_process'
import { createRpcClient, type RpcClient } from './rpc.js'
import { PassThrough, type Readable, type Writable } from 'node:stream'

interface Location {
  uri: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
}

interface ServerCapabilities {
  definitionProvider?: boolean
  referencesProvider?: boolean
  /** LSP 3.17+: server supports textDocument/diagnostic pull model. */
  diagnosticProvider?: unknown
}

/** Simplified LSP Diagnostic for file-level error reporting. */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity: 1 | 2 | 3 | 4  // Error / Warning / Info / Hint
  message: string
  source?: string
}

export interface LspManager {
  initialize(): Promise<void>
  isReady(): boolean
  supportsDefinition(): boolean
  supportsReferences(): boolean
  gotoDefinition(filePath: string, line: number, character: number): Promise<Location[]>
  findReferences(filePath: string, line: number, character: number): Promise<Location[]>
  /** Notify the LSP server that a file was modified on disk (e.g. by edit_file/write_file).
   *  Ensures the LSP's internal state stays in sync for subsequent goto-def / find-refs queries. */
  changeFile(filePath: string): void
  /** T4: file-level diagnostics. Uses pull model (textDocument/diagnostic) if
   *  supported, otherwise falls back to cached publishDiagnostics.
   *  Timeout ~2s; returns empty array on timeout or server unavailability. */
  getFileDiagnostics(filePath: string, timeoutMs?: number): Promise<LspDiagnostic[]>
  dispose(): void
}

type SpawnFn = () => ChildProcess

function uriToRelPath(uri: string, cwd: string): string {
  // file:///project/src/foo.ts → src/foo.ts (relative to cwd)
  const prefix = `file://${cwd}/`
  if (uri.startsWith(prefix)) {
    return uri.slice(prefix.length)
  }
  // Fallback: strip file:// and leading slash
  const stripped = uri.replace(/^file:\/\/\/?/, '')
  return stripped
}

function languageId(filePath: string): string {
  if (filePath.endsWith('.tsx')) return 'typescriptreact'
  if (filePath.endsWith('.ts')) return 'typescript'
  if (filePath.endsWith('.jsx')) return 'javascriptreact'
  return 'javascript'
}

export function createLspManager(spawnFn: SpawnFn, cwd: string): LspManager {
  let rpc: RpcClient | null = null
  let proc: ChildProcess | null = null
  let capabilities: ServerCapabilities | null = null
  let ready = false
  const openedDocs = new Set<string>()
  /** T4: diagnostic cache keyed by URI, populated from publishDiagnostics notifications. */
  const diagnosticCache = new Map<string, LspDiagnostic[]>()

  /**
   * Ensure the document is opened in the LSP server.
   * Uses a dummy text because TypeScript language server reads from disk
   * and does not rely on the text content from didOpen.
   * Caches opened URIs — only sends didOpen + waits on first access.
   */
  async function ensureDocument(filePath: string): Promise<void> {
    if (!rpc) return
    const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
    const uri = `file://${absPath}`
    if (openedDocs.has(uri)) return
    openedDocs.add(uri)
    try {
      rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageId(filePath),
          version: 1,
          text: '',
        },
      })
      // Allow server to process the notification
      await new Promise(r => setTimeout(r, 100))
    } catch {
      // Best-effort document registration
    }
  }

  return {
    async initialize() {
      try {
        proc = spawnFn()

        // stdin is writable (we send requests), stdout is readable (we receive responses)
        const stdin = proc.stdin as Writable
        const stdout = proc.stdout as Readable

        // Handle stderr — TypeScript language server logs diagnostics here
        if (proc.stderr) {
          proc.stderr.on('data', () => {
            // Silently consume — LSP servers may log diagnostics to stderr
          })
        }

        proc.on('error', () => {
          ready = false
        })

        rpc = createRpcClient(stdout, stdin)

        const initResult = await rpc.request('initialize', {
          processId: process.pid,
          rootUri: `file://${cwd}`,
          capabilities: {
            textDocument: {
              definition: { linkSupport: false },
              references: {},
            },
          },
        }) as { capabilities: ServerCapabilities }

        capabilities = initResult.capabilities
        rpc.notify('initialized', {})

        // T4: listen for publishDiagnostics to populate the cache
        rpc.onNotification('textDocument/publishDiagnostics', (rawParams: Record<string, unknown>) => {
          const params = rawParams as { uri: string; diagnostics: LspDiagnostic[] }
          if (params?.uri) {
            diagnosticCache.set(params.uri, params.diagnostics ?? [])
          }
        })

        // Wait for server to fully settle after initialization
        await new Promise(r => setTimeout(r, 200))
        ready = true
      } catch (err) {
        ready = false
        try { proc?.kill() } catch { /* ignore */ }
        proc = null
        rpc = null
      }
    },

    isReady() {
      return ready
    },

    supportsDefinition() {
      return capabilities?.definitionProvider === true
    },

    supportsReferences() {
      return capabilities?.referencesProvider === true
    },

    async gotoDefinition(filePath, line, character) {
      if (!rpc || !ready) return []
      try {
        await ensureDocument(filePath)
        const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
        const result = await rpc.request('textDocument/definition', {
          textDocument: { uri: `file://${absPath}` },
          position: { line: line - 1, character }, // LSP uses 0-based lines
        })

        if (!result) return []

        const locations = (Array.isArray(result) ? result : [result]) as Location[]
        return locations.map(loc => ({
          ...loc,
          uri: uriToRelPath(loc.uri, cwd),
        }))
      } catch {
        return []
      }
    },

    async findReferences(filePath, line, character) {
      if (!rpc || !ready) return []
      try {
        await ensureDocument(filePath)
        const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
        const result = await rpc.request('textDocument/references', {
          textDocument: { uri: `file://${absPath}` },
          position: { line: line - 1, character },
          context: { includeDeclaration: false },
        })

        if (!result) return []

        const locations = (Array.isArray(result) ? result : []) as Location[]
        return locations.map(loc => ({
          ...loc,
          uri: uriToRelPath(loc.uri, cwd),
        }))
      } catch {
        return []
      }
    },

    changeFile(filePath) {
      if (!rpc || !ready) return
      const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
      const uri = `file://${absPath}`
      if (!openedDocs.has(uri)) return // never opened, server has no cached state
      try {
        rpc.notify('textDocument/didChange', {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: '' }],
        })
      } catch {
        // Best-effort: if the notification fails, next LSP query re-reads from disk anyway
      }
    },

    async getFileDiagnostics(filePath, timeoutMs = 2000) {
      if (!rpc || !ready) return []
      const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
      const uri = `file://${absPath}`

      try {
        // Prefer pull model (LSP 3.17+ textDocument/diagnostic)
        if (capabilities?.diagnosticProvider) {
          const result = await Promise.race([
            rpc.request('textDocument/diagnostic', {
              textDocument: { uri },
            }) as Promise<{ items?: LspDiagnostic[] }>,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ])
          if (result?.items) return result.items
        }

        // Fallback: trigger a didChange with real file content to refresh publishDiagnostics
        await ensureDocument(filePath)
        // Read actual file content — empty text would tell tsserver the file is empty (false green)
        let fileText = ''
        try {
          const { readFileSync } = await import('node:fs')
          fileText = readFileSync(absPath, 'utf-8')
        } catch {
          // File may not exist on disk — use empty text as last resort
        }
        // Clear stale cache BEFORE notify — avoid racing server publishDiagnostics
        diagnosticCache.delete(uri)
        rpc.notify('textDocument/didChange', {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: fileText }],
        })
        // Wait for publishDiagnostics to arrive (server pushes asynchronously)
        await new Promise<void>((resolve) => {
          const start = Date.now()
          const check = () => {
            if (diagnosticCache.has(uri) || Date.now() - start > timeoutMs) {
              resolve()
            } else {
              setTimeout(check, 50)
            }
          }
          check()
        })
        return diagnosticCache.get(uri) ?? []
      } catch {
        return []
      }
    },

    dispose() {
      ready = false
      try { rpc?.dispose() } catch { /* ignore */ }
      try { proc?.kill() } catch { /* ignore */ }
      proc = null
      rpc = null
    },
  }
}
