# 启动内存优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 启动 RSS 从 135MB 降至 ~95-103MB，同时保持 prefix cache 完整性和所有现有测试通过。

**架构：** 分三个 Phase 递进优化。Phase 1 将三个最重的非关键路径依赖（MCP SDK 24MB、better-sqlite3 6MB、turndown 2MB）从静态 import 改为动态 `await import()`，在首次使用时才加载。Phase 2 优化 tsup 构建配置，添加 treeshake 和多入口点。Phase 3 将 web-fetch 中的 turndown 从模块顶层初始化改为执行时延迟初始化。

**技术栈：** Node.js 22 / TypeScript strict / ESM / tsup / node:test

**前置知识：**
- `src/main.tsx` 是唯一入口，包含 Root 组件和 CLI 路由
- `SessionRegistry`（better-sqlite3）在 main.tsx:686 实例化，用于多实例共存和崩溃检测
- `McpManager`（MCP SDK）在 Root 组件的 useEffect 中实例化（main.tsx:135），仅在 MCP 配置启用时加载
- `WEB_FETCH_TOOL` 在 `default-registry.ts:15` 静态 import，导致 turndown 在启动时就被加载
- **prefix cache 硬约束**：PromptEngine 和 ToolRegistry 必须在首轮 API 调用前完全就绪，toolsSha256 不可变

**验证基准（在修改前运行一次）：**
```bash
node -e "
const start = process.hrtime.bigint();
import('./dist/main.js').then(() => {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const m = process.memoryUsage();
  console.log(JSON.stringify({
    startupMs: ms.toFixed(0),
    rss_MB: (m.rss/1048576).toFixed(1),
    heapUsed_MB: (m.heapUsed/1048576).toFixed(1),
  }));
  process.exit(0);
});
"
```

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/agent/session-registry.ts` | 将顶层 `import Database` 改为构造器内动态 import |
| 修改 | `src/main.tsx` | 将 `McpManager` 和 `SessionRegistry` 的静态 import 改为动态 |
| 修改 | `src/tools/web-fetch.ts` | 将 turndown 从模块顶层初始化改为延迟初始化 |
| 修改 | `src/tools/default-registry.ts` | 将 `WEB_FETCH_TOOL` 从静态 import 改为延迟注册 |
| 修改 | `tsup.config.ts` | 添加 treeshake、external 优化 |
| 创建 | `src/__tests__/startup-memory.test.ts` | 启动内存基准回归测试 |

---

### 任务 1：创建启动内存基准测试

**文件：**
- 创建：`src/__tests__/startup-memory.test.ts`

- [ ] **步骤 1：编写基准测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

describe('startup memory baseline', () => {
  it('RSS should be below 115MB after import', async () => {
    const { stdout } = await execFileAsync('node', [
      '--max-old-space-size=256',
      '-e',
      `import('./dist/main.js').then(() => {
        const m = process.memoryUsage();
        console.log(JSON.stringify({ rss_MB: +(m.rss / 1048576).toFixed(1) }));
        process.exit(0);
      }).catch(() => process.exit(0));`,
    ], { timeout: 15_000 })

    const lines = stdout.trim().split('\n')
    const last = lines[lines.length - 1]
    let rss = 200
    try { rss = JSON.parse(last).rss_MB } catch { /* use default */ }
    assert.ok(rss < 115, `Startup RSS ${rss}MB exceeds 115MB budget`)
  })
})
```

- [ ] **步骤 2：运行测试验证当前 baseline 失败**

运行：`npx tsx --test src/__tests__/startup-memory.test.ts`
预期：FAIL — 当前 RSS ~135MB 超过 115MB 预算

- [ ] **步骤 3：Commit**

```bash
git add src/__tests__/startup-memory.test.ts
git commit -m "test(perf): add startup memory baseline regression test"
```

---

### 任务 2：延迟加载 better-sqlite3（SessionRegistry）

**文件：**
- 修改：`src/agent/session-registry.ts:1-2` — 移除顶层 import
- 修改：`src/agent/session-registry.ts:42-52` — 构造器改为异步工厂
- 修改：`src/main.tsx:39,686-735` — 调用方改为 await 工厂函数

- [ ] **步骤 1：修改 session-registry.ts — 动态 import + 异步工厂**

将 `src/agent/session-registry.ts` 的顶层 import 和构造器改为：

```typescript
// 移除: import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// ... interfaces and SCHEMA const stay unchanged ...

export class SessionRegistry {
  private db: any // better-sqlite3 Database instance

  private constructor(db: any) {
    this.db = db
  }

  static async create(stateDir: string): Promise<SessionRegistry> {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const { default: Database } = await import('better-sqlite3')
    const dbPath = join(stateDir, 'registry.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    return new SessionRegistry(db)
  }

  // ... all other methods stay unchanged (register, heartbeat, unregister, etc.)
```

注意：`private db` 类型改为 `any` 是因为 `better-sqlite3` 的类型在动态 import 后不可用于静态声明。所有方法体内的 `this.db` 调用不需要改动，因为 better-sqlite3 的 API 在运行时不变。

- [ ] **步骤 2：修改 main.tsx — SessionRegistry 调用方**

在 `src/main.tsx` 中，将 SessionRegistry 的使用从同步构造改为 await：

```typescript
// 行 39: 移除静态 import
// 移除: import { SessionRegistry } from './agent/session-registry.js'

// 行 686-735: 改为动态 import + await create
  const { SessionRegistry } = await import('./agent/session-registry.js')
  const stateDir = join(homedir(), '.rivet', 'state')
  const registry = await SessionRegistry.create(stateDir)

  // 后续代码不变 — registry.register(), registry.detectCrashedSessions() 等
```

- [ ] **步骤 3：修改 coordinator.ts 的类型引用**

`src/agent/coordinator.ts:71` 已经用 `import('./session-registry.js').SessionRegistry` 类型导入，不需要改动。确认无其他文件静态 import SessionRegistry。

运行：`grep -rn "from.*session-registry" src/ --include="*.ts" | grep -v __tests__ | grep -v ".d.ts"`

- [ ] **步骤 4：构建并运行类型检查**

运行：`npx tsc --noEmit`
预期：无类型错误（`any` 类型会通过，实例方法调用不受影响）

- [ ] **步骤 5：运行现有测试确认无回归**

运行：`npx tsx --test src/__tests__/session-isolation.test.ts`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/agent/session-registry.ts src/main.tsx
git commit -m "perf(startup): lazy-load better-sqlite3 via async SessionRegistry.create()"
```

---

### 任务 3：延迟加载 MCP SDK（McpManager）

**文件：**
- 修改：`src/main.tsx:33,75,127-160` — McpManager 动态 import

- [ ] **步骤 1：修改 main.tsx — McpManager 动态 import**

在 `src/main.tsx` 中：

```typescript
// 行 33: 移除静态 import
// 移除: import { McpManager } from './mcp/manager.js'

// 行 75: 改类型为 any
let _mcpManager: any = null

// 行 127-160 的 useEffect 内部改为动态 import:
  useEffect(() => {
    if (!config.mcp.enabled || Object.keys(config.mcp.servers).length === 0) {
      setMcpReady(true)
      return
    }

    import('./mcp/manager.js').then(({ McpManager }) => {
      const mgr = new McpManager(config.mcp)
      _mcpManager = mgr
      mcpManagerRef.current = mgr

      mgr.initialize().then(() => {
        const mcpTools = mgr.getAllTools()
        for (const tool of mcpTools) {
          toolRegistry.register(tool)
        }
        setMcpReady(true)
        setToolVersion(v => v + 1)

        const states = mgr.getStates()
        const connected = states.filter(s => s.status === 'connected')
        const failed = states.filter(s => s.status === 'error')
        // ... rest of the logging stays unchanged
      })
    })

    return () => {
      if (mcpManagerRef.current) {
        mcpManagerRef.current.shutdown().catch(() => {})
      }
    }
  }, [])
```

因为 McpManager 已经在 useEffect 中异步初始化（`.initialize().then(...)`），将 import 本身也改为异步只是在外面再包一层 `import().then()`，对行为没有语义变化。

- [ ] **步骤 2：确认 mcp/manager.ts 的顶层 import 不再被 main.tsx 拉入**

MCP SDK 的两个重依赖是 `@modelcontextprotocol/sdk/client/index.js` 和 `@modelcontextprotocol/sdk/client/stdio.js`，它们在 `mcp/manager.ts` 的顶层 import。动态 import `mcp/manager.js` 意味着这两个 SDK 模块在 MCP 禁用时完全不加载。

- [ ] **步骤 3：构建并类型检查**

运行：`npx tsc --noEmit`
预期：无错误。`_mcpManager` 改为 `any` 类型，useRef 的泛型改为 `any`。

- [ ] **步骤 4：构建并测试**

运行：`npm run build && npx tsx --test src/__tests__/startup-memory.test.ts`
预期：RSS 应该已经下降（MCP 24MB + sqlite 6MB = ~30MB 节省）

- [ ] **步骤 5：Commit**

```bash
git add src/main.tsx
git commit -m "perf(startup): lazy-load MCP SDK — only import when mcp.enabled"
```

---

### 任务 4：延迟初始化 turndown（web-fetch）

**文件：**
- 修改：`src/tools/web-fetch.ts:3,19-26` — turndown 延迟初始化

- [ ] **步骤 1：修改 web-fetch.ts — 延迟初始化 turndown**

将模块顶层的 turndown 初始化改为惰性单例：

```typescript
// 行 3: 移除静态 import
// 移除: import TurndownService from 'turndown'

// 行 19-26: 替换为惰性初始化
let _turndown: any = null

async function getTurndown(): Promise<any> {
  if (!_turndown) {
    const { default: TurndownService } = await import('turndown')
    _turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    })
    _turndown.remove(['script', 'style'])
  }
  return _turndown
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const td = await getTurndown()
  return td.turndown(html)
}
```

注意：`htmlToMarkdown` 从同步变为异步。需要更新调用方。

- [ ] **步骤 2：更新 web-fetch.ts 内部调用方**

在 `execute()` 函数内（约行 160）：

```typescript
// 原来: content = htmlToMarkdown(body)
// 改为:
          content = await htmlToMarkdown(body)
```

因为 `execute()` 已经是 `async` 函数，添加 `await` 不改变行为。

- [ ] **步骤 3：更新 web-fetch 测试**

修改 `src/tools/__tests__/web-fetch.test.ts`：

```typescript
// 原来的测试:
// import { createWebFetchTool, htmlToMarkdown } from '../web-fetch.js'
// ...
// const result = htmlToMarkdown('<p>Hello <strong>world</strong></p>')

// 改为 await:
import { createWebFetchTool, htmlToMarkdown } from '../web-fetch.js'
// ...
const result = await htmlToMarkdown('<p>Hello <strong>world</strong></p>')
```

所有 `htmlToMarkdown()` 调用前添加 `await`。测试函数如果不是 async，改为 async。

- [ ] **步骤 4：运行 web-fetch 测试**

运行：`npx tsx --test src/tools/__tests__/web-fetch.test.ts`
预期：PASS

- [ ] **步骤 5：类型检查**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 6：Commit**

```bash
git add src/tools/web-fetch.ts src/tools/__tests__/web-fetch.test.ts
git commit -m "perf(startup): lazy-init turndown in web-fetch — load on first use"
```

---

### 任务 5：tsup 构建优化 — treeshake + noExternal 审查

**文件：**
- 修改：`tsup.config.ts`

- [ ] **步骤 1：添加 treeshake 到 tsup 配置**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  shims: true,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
```

`treeshake: true` 让 tsup（使用 Rollup）在打包时移除未使用的导出。对于已经改为动态 import 的模块，这确保它们的代码不被包含在主 bundle 中。

- [ ] **步骤 2：构建并比较 bundle 大小**

```bash
wc -c dist/main.js  # 记录修改前的大小（846KB）
npm run build
wc -c dist/main.js  # 对比修改后的大小
```

预期：bundle 应该略微减小（移除了 turndown 初始化和未使用的导出）

- [ ] **步骤 3：运行全量测试确认无回归**

运行：`npx tsx --test src/**/__tests__/*.test.ts`
预期：全部 PASS（已知 flaky: compact.test.ts 的 "truncates old messages iteratively" 可能偶尔失败）

- [ ] **步骤 4：Commit**

```bash
git add tsup.config.ts
git commit -m "perf(build): enable treeshake in tsup for dead code elimination"
```

---

### 任务 6：最终验证 — 内存基准回归测试通过

**文件：** 无新改动，纯验证

- [ ] **步骤 1：完整构建**

运行：`npm run build`

- [ ] **步骤 2：运行启动内存测试**

运行：`npx tsx --test src/__tests__/startup-memory.test.ts`
预期：PASS — RSS < 115MB

- [ ] **步骤 3：运行内存基准测量脚本**

```bash
node -e "
const start = process.hrtime.bigint();
import('./dist/main.js').then(() => {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const m = process.memoryUsage();
  console.log(JSON.stringify({
    startupMs: ms.toFixed(0),
    rss_MB: (m.rss/1048576).toFixed(1),
    heapUsed_MB: (m.heapUsed/1048576).toFixed(1),
    external_MB: (m.external/1048576).toFixed(1),
  }, null, 2));
  process.exit(0);
});
"
```

预期结果：
- RSS: ~95-105MB（从 135MB 降低 ~30MB）
- Heap used: ~25-30MB（从 37.8MB 降低）
- 启动时间: ~400-500ms（变化不大，因为动态 import 的开销在后续首次使用时发生）

- [ ] **步骤 4：运行全量测试 + 类型检查**

```bash
npx tsc --noEmit && npx tsx --test src/**/__tests__/*.test.ts
```

预期：全部 PASS

- [ ] **步骤 5：最终 Commit**

```bash
git add -A
git commit -m "perf(startup): verified — RSS reduced ~30MB via lazy loading of MCP/sqlite/turndown"
```

---

## 自检结果

**1. 规格覆盖度：**
- Phase 1（3 个延迟加载）：任务 2/3/4 覆盖 ✓
- Phase 2（tsup 优化）：任务 5 覆盖 ✓
- 回归测试：任务 1 和 6 覆盖 ✓
- Prefix cache 完整性：三个延迟加载都不涉及 PromptEngine/ToolRegistry ✓

**2. 占位符扫描：** 无 TODO、待定、后续实现。所有代码块完整。

**3. 类型一致性：**
- `SessionRegistry.create()` 在 task 2 定义，task 2 step 2 中 main.tsx 正确调用 `await SessionRegistry.create(stateDir)`
- `htmlToMarkdown` 在 task 4 改为 async，task 4 step 3 更新了测试中的调用
- `_mcpManager` 在 task 3 改为 `any`，与移除静态 import 一致
