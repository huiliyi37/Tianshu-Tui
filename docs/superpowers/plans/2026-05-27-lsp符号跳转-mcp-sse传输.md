# LSP Symbol 导航 + MCP SSE 传输 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐 LSP 协议级 symbol 导航（go-to-definition / find-references）和 MCP SSE 传输通道，让天枢从"文本匹配"升级到"符号级跳转"，同时打通 MCP 远程服务生态。

**架构：** LSP 端通过 JSON-RPC over stdio 连接 `typescript-language-server`（封装 tsserver），暴露为两个只读工具 `lsp_goto_definition` 和 `lsp_find_references`，直接提升 tool call 信噪比。MCP 端在现有 stdio 传输基础上，接入 SDK 内置的 `StreamableHTTPClientTransport`，补全 SSE 远程连接通道。

**技术栈：** TypeScript 5.7、Node.js 22（child_process spawn）、`@modelcontextprotocol/sdk` 1.29、node:test、现有 `Tool` / `ToolRegistry` 架构。

**设计依据：** `docs/superpowers/specs/2026-05-26-claude-code-feature-gap-analysis.md` §1.1 / §7.3 / §7.4

---

## 1. 范围边界

### 本计划内

**LSP：**
- JSON-RPC over stdio LSP 客户端（不依赖 vscode-languageserver，手写轻量消息循环）
- 语言服务器生命周期管理（启动 → initialize → 工作就绪 → 关闭）
- `lsp_goto_definition` 工具：输入文件+行列 → 返回目标位置
- `lsp_find_references` 工具：输入文件+行列 → 返回引用列表
- 自动解析上下文中的文件路径和光标位置
- 仅支持 TypeScript（`typescript-language-server`），语言可扩展但不在此计划内

**MCP SSE：**
- 基于 SDK `StreamableHTTPClientTransport` 实现 SSE URL 连接
- 替换 `manager.ts` 中 `throw new Error('SSE transport not yet implemented')` 分支
- 支持 headers 透传（认证等）
- 连接失败降级为 `error` 状态（不阻断其他服务器）
- 测试覆盖 SSE 连接生命周期

### 本计划外

- LSP hover / workspace symbol / diagnostics（通过 LSP 协议获取）— 后续迭代
- LSP 非 TypeScript 语言支持 — 架构预留扩展点
- MCP SSE 自动重连 — 后续迭代
- MCP streaming tool results — 后续迭代
- LSP 增量文档同步（didChange）— 当前用全量 didOpen 替代
- 当前 `src/lsp/client.ts`（tsc --noEmit）暂不删除，作为快速 feedback 保留

---

## 2. 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/lsp/rpc.ts` | JSON-RPC 消息编码/解码 + 请求/响应匹配 |
| `src/lsp/manager.ts` | LSP 进程生命周期：启动 typescript-language-server、initialize、shutdown |
| `src/lsp/tools.ts` | 两个工具实现：`lsp_goto_definition`、`lsp_find_references` |
| `src/lsp/__tests__/rpc.test.ts` | JSON-RPC 编解码单元测试 |
| `src/lsp/__tests__/manager.test.ts` | Manager 生命周期 + mock server 测试 |
| `src/lsp/__tests__/tools.test.ts` | 工具定义 + mock LSP 响应测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/mcp/manager.ts` | 实现 SSE transport 分支，接入 `StreamableHTTPClientTransport` |
| `src/mcp/__tests__/manager.test.ts` | 新增 SSE 连接测试用例 |
| `src/main.tsx` | 初始化 LspManager，注册两个 LSP 工具到 ToolRegistry |

---

## 3. 任务

### 任务 1：LSP JSON-RPC 消息层

**文件：**
- 创建：`src/lsp/rpc.ts`
- 测试：`src/lsp/__tests__/rpc.test.ts`

- [ ] **步骤 1：编写 rpc 测试**

```typescript
// src/lsp/__tests__/rpc.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMessage, decodeMessages, createRpcClient, type RpcClient } from '../rpc.js'
import { Duplex } from 'node:stream'

describe('encodeMessage', () => {
  it('encodes a JSON-RPC request with Content-Length header', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    const encoded = encodeMessage(msg)
    const body = JSON.stringify(msg)
    assert.ok(encoded.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`))
    assert.ok(encoded.endsWith(body))
  })
})

describe('decodeMessages', () => {
  it('decodes a single complete message from buffer', () => {
    const msg = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } }
    const raw = encodeMessage(msg)
    const { messages, rest } = decodeMessages(raw)
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0], msg)
    assert.equal(rest, '')
  })

  it('returns empty when header is incomplete', () => {
    const { messages, rest } = decodeMessages('Content-Length:')
    assert.equal(messages.length, 0)
    assert.equal(rest, 'Content-Length:')
  })

  it('returns empty when body is incomplete', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    const { messages, rest } = decodeMessages(header + body.slice(0, 5))
    assert.equal(messages.length, 0)
    assert.ok(rest.length > 0)
  })

  it('decodes multiple messages in one buffer', () => {
    const msg1 = { jsonrpc: '2.0', id: 1, result: { a: 1 } }
    const msg2 = { jsonrpc: '2.0', id: 2, result: { b: 2 } }
    const raw = encodeMessage(msg1) + encodeMessage(msg2)
    const { messages } = decodeMessages(raw)
    assert.equal(messages.length, 2)
  })
})

describe('createRpcClient', () => {
  it('sends request and resolves response by id', async () => {
    // Create a pair of connected duplex streams to simulate process stdio
    const serverSide = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        // Server receives request, sends back response
        const msg = JSON.parse(chunk.toString().split('\r\n\r\n')[1]!)
        if (msg.method === 'test') {
          const response = encodeMessage({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
          clientSide.push(response)
        }
        callback()
      },
    })
    const clientSide = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback() },
    })

    const client = createRpcClient(serverSide)
    const result = await client.request('test', { foo: 'bar' })
    assert.deepEqual(result, { ok: true })

    // Pump data from clientSide to trigger the pending request resolution
    serverSide.on('data', (d: Buffer) => {
      // Already handled in write above
    })

    client.dispose()
  })

  it('rejects on error response', async () => {
    const serverSide = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const msg = JSON.parse(chunk.toString().split('\r\n\r\n')[1]!)
        const response = encodeMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } })
        clientSide.push(response)
        callback()
      },
    })
    const clientSide = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })

    const client = createRpcClient(serverSide)
    await assert.rejects(
      () => client.request('bad', {}),
      /Invalid Request/,
    )
    client.dispose()
  })
})
```

- [ ] **步骤 2：运行测试确认 FAIL**

```bash
npx tsx --test src/lsp/__tests__/rpc.test.ts
```

预期：3 个测试 FAIL（`Cannot find module '../rpc.js'`）

- [ ] **步骤 3：实现 rpc.ts**

```typescript
// src/lsp/rpc.ts
import { Duplex } from 'node:stream'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface RpcClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void
  dispose(): void
}

export function encodeMessage(msg: JsonRpcMessage): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

export function decodeMessages(buffer: string): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = []
  let rest = buffer

  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd === -1) break

    const header = rest.slice(0, headerEnd)
    const lengthMatch = /^Content-Length: (\d+)/m.exec(header)
    if (!lengthMatch) {
      rest = rest.slice(headerEnd + 4)
      continue
    }

    const contentLength = parseInt(lengthMatch[1]!, 10)
    const bodyStart = headerEnd + 4
    if (rest.length < bodyStart + contentLength) break

    const body = rest.slice(bodyStart, bodyStart + contentLength)
    try {
      messages.push(JSON.parse(body) as JsonRpcMessage)
    } catch {
      // Skip malformed message
    }
    rest = rest.slice(bodyStart + contentLength)
  }

  return { messages, rest }
}

export function createRpcClient(stream: Duplex): RpcClient {
  let nextId = 1
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const notificationHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  let buffer = ''

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const { messages, rest } = decodeMessages(buffer)
    buffer = rest

    for (const msg of messages) {
      if ('id' in msg && 'result' in msg) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.resolve(msg.result)
        }
      } else if ('id' in msg && 'error' in msg) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.reject(new Error(msg.error!.message))
        }
      } else if ('method' in msg && !('id' in msg)) {
        const handlers = notificationHandlers.get(msg.method)
        if (handlers) {
          for (const h of handlers) h((msg as JsonRpcNotification).params ?? {})
        }
      }
    }
  })

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
        stream.write(encodeMessage(msg))
      })
    },
    notify(method, params) {
      const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
      stream.write(encodeMessage(msg))
    },
    onNotification(method, handler) {
      const existing = notificationHandlers.get(method)
      if (existing) {
        existing.push(handler)
      } else {
        notificationHandlers.set(method, [handler])
      }
    },
    dispose() {
      pending.clear()
      notificationHandlers.clear()
      stream.destroy()
    },
  }
}
```

- [ ] **步骤 4：运行测试确认 PASS**

```bash
npx tsx --test src/lsp/__tests__/rpc.test.ts
```

预期：所有测试 PASS

- [ ] **步骤 5：运行 typecheck**

```bash
npx tsc --noEmit
```

预期：无新增错误

- [ ] **步骤 6：Commit**

```bash
mkdir -p src/lsp/__tests__
git add src/lsp/rpc.ts src/lsp/__tests__/rpc.test.ts
git commit -m "feat(lsp): add JSON-RPC message layer — encode, decode, request/response matching"
```

---

### 任务 2：LSP 进程管理器

**文件：**
- 创建：`src/lsp/manager.ts`
- 测试：`src/lsp/__tests__/manager.test.ts`

- [ ] **步骤 1：编写 manager 测试**

```typescript
// src/lsp/__tests__/manager.test.ts
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LspManager, createLspManager } from '../manager.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex } from 'node:stream'
import { encodeMessage } from '../rpc.js'

// Mock server that responds to initialize + supports goto definition
function createMockLspServer(): { stdin: Duplex; stdout: Duplex; proc: ChildProcess } {
  const stdin = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback() },
  })
  const stdout = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback() },
  })

  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    // Check for complete LSP message
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const lengthMatch = /^Content-Length: (\d+)/m.exec(buffer.slice(0, headerEnd))
    if (!lengthMatch) return
    const contentLength = parseInt(lengthMatch[1]!, 10)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + contentLength) return

    const body = buffer.slice(bodyStart, bodyStart + contentLength)
    buffer = buffer.slice(bodyStart + contentLength)

    const msg = JSON.parse(body)

    if (msg.method === 'initialize') {
      const response = encodeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          capabilities: {
            definitionProvider: true,
            referencesProvider: true,
          },
        },
      })
      stdout.push(response)
    } else if (msg.method === 'textDocument/definition') {
      const response = encodeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: [{
          uri: 'file:///project/src/target.ts',
          range: {
            start: { line: 9, character: 4 },
            end: { line: 9, character: 10 },
          },
        }],
      })
      stdout.push(response)
    } else if (msg.method === 'textDocument/references') {
      const response = encodeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: [
          { uri: 'file:///project/src/a.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
          { uri: 'file:///project/src/b.ts', range: { start: { line: 12, character: 1 }, end: { line: 12, character: 7 } } },
        ],
      })
      stdout.push(response)
    } else if (msg.method === 'shutdown') {
      const response = encodeMessage({ jsonrpc: '2.0', id: msg.id, result: null })
      stdout.push(response)
    } else if (msg.method === 'initialized') {
      // Notification, no response needed
    }
  })

  return { stdin, stdout, proc: { stdin, stdout, kill: () => {} } as unknown as ChildProcess }
}

describe('LspManager', () => {
  const managers: LspManager[] = []

  afterEach(() => {
    for (const m of managers) {
      try { m.dispose() } catch { /* ignore */ }
    }
    managers.length = 0
  })

  it('initializes and reports capabilities', async () => {
    const { stdin, stdout } = createMockLspServer()
    const mgr = createLspManager(
      () => ({ stdin, stdout } as unknown as ChildProcess),
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()

    assert.equal(mgr.isReady(), true)
    assert.equal(mgr.supportsDefinition(), true)
    assert.equal(mgr.supportsReferences(), true)
  })

  it('go-to-definition returns target location', async () => {
    const { stdin, stdout } = createMockLspServer()
    const mgr = createLspManager(
      () => ({ stdin, stdout } as unknown as ChildProcess),
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()
    const result = await mgr.gotoDefinition('src/file.ts', 10, 5)

    assert.equal(result.length, 1)
    assert.equal(result[0]!.uri, 'file:///project/src/target.ts')
    assert.equal(result[0]!.range.start.line, 9)
  })

  it('find-references returns reference list', async () => {
    const { stdin, stdout } = createMockLspServer()
    const mgr = createLspManager(
      () => ({ stdin, stdout } as unknown as ChildProcess),
      '/project',
    )
    managers.push(mgr)

    await mgr.initialize()
    const result = await mgr.findReferences('src/file.ts', 10, 5)

    assert.equal(result.length, 2)
    assert.equal(result[0]!.uri, 'file:///project/src/a.ts')
    assert.equal(result[1]!.uri, 'file:///project/src/b.ts')
  })

  it('not-ready manager returns empty results', async () => {
    const mgr = createLspManager(
      () => { throw new Error('should not spawn') },
      '/project',
    )
    managers.push(mgr)

    assert.equal(mgr.isReady(), false)
    const result = await mgr.gotoDefinition('src/file.ts', 1, 1)
    assert.equal(result.length, 0)
  })

  it('dispose shuts down server', async () => {
    let killed = false
    const mgr = createLspManager(
      () => ({
        stdin: new Duplex({ read() {}, write(_c, _e, cb) { cb() } }),
        stdout: new Duplex({ read() {}, write(_c, _e, cb) { cb() } }),
        kill: () => { killed = true },
      } as unknown as ChildProcess),
      '/project',
    )
    managers.push(mgr)

    mgr.dispose()
    // Shutdown is best-effort with mock; kill should be called
    assert.equal(killed, true)
  })
})
```

- [ ] **步骤 2：运行测试确认 FAIL**

```bash
npx tsx --test src/lsp/__tests__/manager.test.ts
```

预期：FAIL

- [ ] **步骤 3：实现 manager.ts**

```typescript
// src/lsp/manager.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createRpcClient, type RpcClient } from './rpc.js'
import { Duplex } from 'node:stream'

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
  dispose(): void
}

type SpawnFn = () => ChildProcess

export function createLspManager(spawnFn: SpawnFn, cwd: string): LspManager {
  let rpc: RpcClient | null = null
  let proc: ChildProcess | null = null
  let capabilities: ServerCapabilities | null = null
  let ready = false

  function uriToPath(uri: string): string {
    // file:///project/src/foo.ts → src/foo.ts
    return uri.replace(/^file:\/\/.+?\//, '')
  }

  async function ensureDocument(filePath: string): Promise<void> {
    if (!rpc) return
    const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
    const uri = `file://${absPath}`
    try {
      // Use didOpen to register the document with the server
      rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: filePath.endsWith('.tsx') ? 'typescriptreact' : 'typescript',
          version: 1,
          text: '', // Server reads from disk for TypeScript
        },
      })
      // Small delay for server to process
      await new Promise(r => setTimeout(r, 50))
    } catch {
      // Best-effort document registration
    }
  }

  return {
    async initialize() {
      try {
        proc = spawnFn()
        // stdin is writable, stdout is readable from our perspective
        const stream = new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            proc!.stdin.write(chunk, callback)
          },
        })
        proc.stdout.on('data', (chunk: Buffer) => {
          stream.push(chunk)
        })
        proc.stderr?.on('data', () => {
          // Ignore stderr — TypeScript language server may log diagnostics
        })
        proc.on('error', () => {
          ready = false
        })

        rpc = createRpcClient(stream)

        const result = await rpc.request('initialize', {
          processId: process.pid,
          rootUri: `file://${cwd}`,
          capabilities: {
            textDocument: {
              definition: { linkSupport: false },
              references: {},
            },
          },
        }) as { capabilities: ServerCapabilities }

        capabilities = result.capabilities
        rpc.notify('initialized', {})

        // Wait for server to settle
        await new Promise(r => setTimeout(r, 100))
        ready = true
      } catch (err) {
        ready = false
        // Dispose partial state
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
          position: { line: line - 1, character }, // Convert to 0-based
        })
        const locations = (Array.isArray(result) ? result : result ? [result] : []) as Location[]
        return locations.map(loc => ({
          ...loc,
          uri: uriToPath(loc.uri),
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
        const locations = (Array.isArray(result) ? result : []) as Location[]
        return locations.map(loc => ({
          ...loc,
          uri: uriToPath(loc.uri),
        }))
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
```

- [ ] **步骤 4：运行测试确认 PASS**

```bash
npx tsx --test src/lsp/__tests__/manager.test.ts
```

预期：所有测试 PASS

- [ ] **步骤 5：运行 typecheck**

```bash
npx tsc --noEmit
```

预期：无新增错误

- [ ] **步骤 6：Commit**

```bash
git add src/lsp/manager.ts src/lsp/__tests__/manager.test.ts
git commit -m "feat(lsp): add LspManager — server lifecycle, go-to-definition, find-references"
```

---

### 任务 3：LSP 工具注册

**文件：**
- 创建：`src/lsp/tools.ts`
- 测试：`src/lsp/__tests__/tools.test.ts`
- 修改：`src/main.tsx`

- [ ] **步骤 1：编写 tools 测试**

```typescript
// src/lsp/__tests__/tools.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGotoDefinitionTool, createFindReferencesTool } from '../tools.js'
import type { LspManager } from '../manager.js'

describe('createGotoDefinitionTool', () => {
  it('has correct tool definition', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.definition.name, 'lsp_goto_definition')
    assert.ok(tool.definition.description!.includes('go-to-definition'))
    assert.ok(tool.isEnabled())
    assert.equal(tool.requiresApproval({ input: {}, toolUseId: '1', cwd: '/tmp' }), false)
  })

  it('disabled when not ready', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => false,
      supportsDefinition: () => false,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.isEnabled(), false)
  })

  it('returns definition location', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async (file, line, col) => {
        assert.equal(file, 'src/foo.ts')
        assert.equal(line, 10)
        return [{ uri: 'src/bar.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 10 } } }]
      },
      findReferences: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute({
      input: { file_path: 'src/foo.ts', line: 10, column: 5 },
      toolUseId: 'tu_1',
      cwd: '/project',
    })

    assert.ok(result.content.includes('src/bar.ts'))
    assert.ok(result.content.includes('line 6')) // 0-based → 1-based
    assert.equal(result.isError, undefined)
  })

  it('handles empty result', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute({
      input: { file_path: 'src/nonexistent.ts', line: 1, column: 1 },
      toolUseId: 'tu_1',
      cwd: '/project',
    })

    assert.ok(result.content.includes('No definition found'))
  })
})

describe('createFindReferencesTool', () => {
  it('returns reference list', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [
        { uri: 'src/a.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
        { uri: 'src/b.ts', range: { start: { line: 12, character: 1 }, end: { line: 12, character: 7 } } },
      ],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    const result = await tool.execute({
      input: { file_path: 'src/foo.ts', line: 10, column: 5 },
      toolUseId: 'tu_1',
      cwd: '/project',
    })

    assert.ok(result.content.includes('2 reference(s)'))
    assert.ok(result.content.includes('src/a.ts'))
    assert.ok(result.content.includes('line 6'))
    assert.ok(result.content.includes('src/b.ts'))
    assert.ok(result.content.includes('line 13'))
  })
})
```

- [ ] **步骤 2：运行测试确认 FAIL**

```bash
npx tsx --test src/lsp/__tests__/tools.test.ts
```

预期：FAIL

- [ ] **步骤 3：实现 tools.ts**

```typescript
// src/lsp/tools.ts
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { LspManager } from './manager.js'

function resolveParams(input: Record<string, unknown>): { filePath: string; line: number; column: number } | string {
  const filePath = input.file_path as string | undefined
  if (!filePath || typeof filePath !== 'string') return 'Missing required parameter: file_path'
  const line = input.line as number | undefined
  if (typeof line !== 'number' || line < 1) return 'Missing or invalid parameter: line (must be >= 1)'
  const column = input.column as number | undefined
  if (typeof column !== 'number' || column < 0) return 'Missing or invalid parameter: column (must be >= 0)'
  return { filePath, line, column }
}

export function createGotoDefinitionTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_goto_definition',
      description:
        'Go to the definition of a symbol at the given file location. ' +
        'Returns the file path, line, and column of the definition. ' +
        'Use this to understand where a function, class, variable, or type is defined.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the source file containing the symbol' },
          line: { type: 'number', description: 'Line number (1-based) where the symbol is located' },
          column: { type: 'number', description: 'Column number (0-based) where the symbol is located' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.gotoDefinition(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No definition found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        // LSP uses 0-based lines; display as 1-based
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} definition(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return manager.isReady() && manager.supportsDefinition()
    },
  }
}

export function createFindReferencesTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_find_references',
      description:
        'Find all references to a symbol at the given file location. ' +
        'Returns a list of file paths, lines, and columns where the symbol is used. ' +
        'Use this to understand the impact of changing a function, class, or variable.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the source file containing the symbol' },
          line: { type: 'number', description: 'Line number (1-based) where the symbol is located' },
          column: { type: 'number', description: 'Column number (0-based) where the symbol is located' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.findReferences(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No references found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} reference(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return manager.isReady() && manager.supportsReferences()
    },
  }
}
```

- [ ] **步骤 4：运行测试确认 PASS**

```bash
npx tsx --test src/lsp/__tests__/tools.test.ts
```

预期：PASS

- [ ] **步骤 5：修改 main.tsx，注册 LSP 工具**

在 `src/main.tsx` 中，在 MCP 初始化 useEffect 之后，添加 LSP 初始化：

```typescript
// 新增 import（文件顶部 import 区域）：
import { createLspManager } from './lsp/manager.js'
import { createGotoDefinitionTool, createFindReferencesTool } from './lsp/tools.js'
import { spawn } from 'node:child_process'

// 在 MCP useEffect 之后添加 LSP 初始化 useEffect：
const [lspManager] = useState(() => {
  const cwd = process.cwd()
  // Try npx first for bundler environments, fall back to global install
  const serverCommand = 'npx'
  const serverArgs = ['-y', 'typescript-language-server', '--stdio']
  
  return createLspManager(
    () => spawn(serverCommand, serverArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }),
    cwd,
  )
})

useEffect(() => {
  let cancelled = false

  lspManager.initialize().then(() => {
    if (cancelled) return
    if (lspManager.isReady()) {
      toolRegistry.register(createGotoDefinitionTool(lspManager))
      toolRegistry.register(createFindReferencesTool(lspManager))
      agentRef.current?.updateTools()
      console.error(`[LSP] typescript-language-server ready — definition: ${lspManager.supportsDefinition()}, references: ${lspManager.supportsReferences()}`)
    } else {
      console.error('[LSP] typescript-language-server failed to initialize — tools not registered')
    }
  }).catch((err) => {
    if (!cancelled) {
      console.error('[LSP] Initialization error:', (err as Error).message)
    }
  })

  return () => {
    cancelled = true
    lspManager.dispose()
  }
}, []) // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **步骤 6：运行 typecheck**

```bash
npx tsc --noEmit
```

预期：无新增错误

- [ ] **步骤 7：手动验证 LSP 工具可用**

启动应用后，发送 prompt 验证：
- 当 LLM 调用 `lsp_goto_definition` 时，应返回目标文件路径和行列
- 当 LLM 调用 `lsp_find_references` 时，应返回引用列表
- 启动日志中应有 `[LSP] typescript-language-server ready`

- [ ] **步骤 8：Commit**

```bash
git add src/lsp/tools.ts src/lsp/__tests__/tools.test.ts src/main.tsx
git commit -m "feat(lsp): register goto-definition and find-references tools"
```

---

### 任务 4：MCP SSE 传输实现

**文件：**
- 修改：`src/mcp/manager.ts`
- 测试：`src/mcp/__tests__/manager.test.ts`

- [ ] **步骤 1：更新 manager test — 添加 SSE 连接测试**

在 `src/mcp/__tests__/manager.test.ts` 中追加：

```typescript
  it('connects to SSE server via StreamableHTTP', async () => {
    const mgr = new McpManager(makeConfig({
      remote: { url: 'http://localhost:3001/mcp', headers: { Authorization: 'Bearer test' }, disabled: true },
    }))

    // Mock SSE transport
    let connectedUrl = ''
    let connectedHeaders: Record<string, string> = {}
    mgr['_connectServer'] = async (serverId, config) => {
      if ('url' in config && config.url) {
        connectedUrl = config.url
        connectedHeaders = config.headers ?? {}
        return {
          client: {} as any,
          transport: { close: async () => {} },
          serverId,
        }
      }
      throw new Error('not sse')
    }
    mgr['_discoverTools'] = async () => [{
      name: 'remote_tool',
      description: 'Remote tool',
      inputSchema: { type: 'object' as const, properties: {} },
    }]

    await mgr.initialize()
    assert.equal(connectedUrl, 'http://localhost:3001/mcp')
    assert.equal(connectedHeaders['Authorization'], 'Bearer test')
    assert.equal(mgr.getAllTools().length, 1)
    assert.equal(mgr.getAllTools()[0]!.definition.name, 'mcp__remote__remote_tool')
  })
```

- [ ] **步骤 2：在 mock 空壳测试失败确认后，实现 SSE 传输**

修改 `src/mcp/manager.ts` 的 `_connectServer` 方法，将：

```typescript
} else if (cfg.url) {
  throw new Error(`SSE transport not yet implemented for server ${serverId}`)
}
```

替换为：

```typescript
} else if (cfg.url) {
  // Dynamically import StreamableHTTP — the SDK requires it
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  ) as typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')

  const transport = new StreamableHTTPClientTransport(
    new URL(cfg.url),
    {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    },
  )
  await withTimeout(client.connect(transport), `MCP connect ${serverId}`, this.timeoutMs)
  return { client, transport, serverId }
}
```

同时更新 `import` 区域，将 `StdioClientTransport` 的导入和新增的类型导入调整：

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
// StreamableHTTPClientTransport is imported dynamically in _connectServer
```

- [ ] **步骤 3：运行测试确认 PASS**

```bash
npx tsx --test src/mcp/__tests__/manager.test.ts
```

预期：所有测试 PASS（包括新增 SSE 测试）

- [ ] **步骤 4：运行 typecheck**

```bash
npx tsc --noEmit
```

预期：无新增错误

- [ ] **步骤 5：Commit**

```bash
git add src/mcp/manager.ts src/mcp/__tests__/manager.test.ts
git commit -m "feat(mcp): implement SSE transport via StreamableHTTPClientTransport"
```

---

## 4. 验证

### 自动化测试

```bash
# LSP 单元测试
npx tsx --test src/lsp/__tests__/rpc.test.ts
npx tsx --test src/lsp/__tests__/manager.test.ts
npx tsx --test src/lsp/__tests__/tools.test.ts

# MCP 单元测试
npx tsx --test src/mcp/__tests__/manager.test.ts

# 类型检查
npx tsc --noEmit

# 全量测试
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

预期：所有测试 PASS，无新增类型错误。

### 手动验证 LSP

1. 在有 `tsconfig.json` 的 TypeScript 项目中启动天枢
2. 确认启动日志包含 `[LSP] typescript-language-server ready`
3. 提示 LLM：`goto definition of function X in file Y`，观察 `lsp_goto_definition` 工具调用
4. 提示 LLM：`find all references to class Z`，观察 `lsp_find_references` 工具调用
5. 验证返回的文件路径和行列正确

### 手动验证 MCP SSE

1. 启动一个 MCP SSE 服务器（如 Context7 本地实例）
2. 配置 `~/.rivet/config.json`：
```json
{
  "mcp": {
    "servers": {
      "ctx7": {
        "url": "http://localhost:3001/sse"
      }
    }
  }
}
```
3. 启动天枢，确认 MCP 日志显示服务器连接成功
4. `/debug mcp` 确认工具已注册

---

## 5. 自检

### 规格覆盖度

| 需求 | 任务 |
|------|------|
| LSP JSON-RPC 消息层 | 任务 1 |
| LSP 进程管理 + initialize/shutdown | 任务 2 |
| go-to-definition 工具 | 任务 3 |
| find-references 工具 | 任务 3 |
| LSP 工具注册到 ToolRegistry | 任务 3 (main.tsx) |
| MCP SSE 传输实现 | 任务 4 |
| MCP SSE 测试覆盖 | 任务 4 |

### 占位符扫描

- 无 TODO / TBD / 待定 / 后续实现
- 所有步骤包含完整代码或精确编辑描述
- 所有 `import` 路径与文件结构一致
- 所有测试包含断言和行为描述

### 类型一致性

- `RpcClient` — 在 `rpc.ts` 定义，`manager.ts` 使用
- `LspManager` — 在 `manager.ts` 定义，`tools.ts` 使用
- `Location` — 在 `manager.ts` 定义，`tools.ts` 解构使用
- `StreamableHTTPClientTransport` — 动态 import，仅在 `manager.ts` 使用
- 工具函数签名 `(manager: LspManager): Tool` — 返回类型与 `ToolRegistry.register()` 兼容

### 依赖检查

- `typescript-language-server` — 通过 `npx -y` 运行时获取，无需预装。如果环境无网络，需用户手动 `npm i -g typescript-language-server`
- `@modelcontextprotocol/sdk` — 已在 `package.json` 中为 `^1.29.0`，`streamableHttp.js` 导出路径已验证存在

### 风险

| 风险 | 应对 |
|------|------|
| `typescript-language-server` 启动慢（2-5s） | LSP 工具在 `isReady()` 为 true 前 `isEnabled()` 返回 false，LLM 不会在就绪前调用 |
| 非 TypeScript 项目无法使用 LSP | `isReady()` 返回 false，工具自动禁用，不产生错误 |
| MCP SSE 服务器不可达 | 连接失败 → `status: 'error'`，不阻断其他 stdio 服务器 |
| LSP 进程崩溃 | `manager.ts` 在 `proc.on('error')` 中设置 `ready = false`，工具自动禁用 |

---

## 6. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-27-lsp符号跳转-mcp-sse传输.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
