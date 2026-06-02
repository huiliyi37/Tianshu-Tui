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

    dispose() {
      ready = false
      try { rpc?.dispose() } catch { /* ignore */ }
      try { proc?.kill() } catch { /* ignore */ }
      proc = null
      rpc = null
    },
  }
}
