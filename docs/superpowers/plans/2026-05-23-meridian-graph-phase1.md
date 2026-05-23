# 经脉图 Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现按需 tree-sitter 解析引擎，在 agent 每次 read_file/edit_file 时自动索引该文件的符号和依赖，存入 SQLite 持久化图，并暴露 `repo_map` tool 供 agent 查询相关代码。

**架构：** postTool hook 检测 read_file/edit_file → 触发 tree-sitter WASM worker 解析单文件 → 提取符号+边写入 better-sqlite3 → `repo_map` tool 做 spreading activation 返回 token-budget 内的相关符号。

**技术栈：** web-tree-sitter + tree-sitter-wasms（TypeScript grammar）、better-sqlite3（已有依赖）、node:worker_threads、node:test

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/repo/meridian-types.ts` | 符号图类型定义 |
| `src/repo/meridian-parser.ts` | tree-sitter 解析：单文件 → symbols + edges |
| `src/repo/meridian-worker.ts` | Worker thread 入口：接收文件路径，返回解析结果 |
| `src/repo/meridian-db.ts` | SQLite 持久化层（schema, upsert, query） |
| `src/repo/meridian-graph.ts` | 图查询：spreading activation + token budget |
| `src/repo/meridian-indexer.ts` | 对外 facade：协调 worker + db + graph |
| `src/agent/hooks/meridian-hook.ts` | postTool hook：检测 read/edit → 触发索引 |
| `src/tools/repo-map.ts` | `repo_map` tool 实现 |
| `src/repo/__tests__/meridian-parser.test.ts` | 解析器测试 |
| `src/repo/__tests__/meridian-db.test.ts` | 数据库层测试 |
| `src/repo/__tests__/meridian-graph.test.ts` | 图查询测试 |
| `src/tools/__tests__/repo-map.test.ts` | tool 集成测试 |

---

## 任务 1：类型定义

**文件：**
- 创建：`src/repo/meridian-types.ts`

- [ ] **步骤 1：创建类型文件**

```typescript
export type MeridianSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'enum'

export type MeridianEdgeKind = 'imports' | 'calls' | 'contains' | 'type_of'

export interface MeridianSymbol {
  id: string
  name: string
  kind: MeridianSymbolKind
  filePath: string
  line: number
  exported: boolean
  contentHash: string
}

export interface MeridianEdge {
  sourceId: string
  targetId: string
  kind: MeridianEdgeKind
  weight: number
}

export interface ParseResult {
  filePath: string
  contentHash: string
  symbols: MeridianSymbol[]
  edges: MeridianEdge[]
  imports: string[]
}

export interface RepoMapEntry {
  filePath: string
  symbols: Array<{ name: string; kind: MeridianSymbolKind; line: number }>
  score: number
}

export interface RepoMapResult {
  entries: RepoMapEntry[]
  totalSymbols: number
  graphSize: number
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/repo/meridian-types.ts
git commit -m "feat(meridian): add type definitions for symbol graph"
```

---

## 任务 2：Tree-sitter 解析器

**文件：**
- 创建：`src/repo/meridian-parser.ts`
- 测试：`src/repo/__tests__/meridian-parser.test.ts`

- [ ] **步骤 1：安装依赖**

```bash
npm install web-tree-sitter tree-sitter-wasms
```

- [ ] **步骤 2：编写失败的测试**

```typescript
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { parseTypeScriptFile, initParser } from '../meridian-parser.js'

describe('meridian parser', () => {
  before(async () => {
    await initParser()
  })

  it('extracts exported function', async () => {
    const result = await parseTypeScriptFile('test.ts', 'export function hello(name: string): void {}')
    const fn = result.symbols.find(s => s.name === 'hello')
    assert.ok(fn)
    assert.equal(fn.kind, 'function')
    assert.equal(fn.exported, true)
    assert.equal(fn.line, 1)
  })

  it('extracts class with methods', async () => {
    const source = `export class Worker {
  run(): void {}
  stop(): void {}
}`
    const result = await parseTypeScriptFile('test.ts', source)
    const cls = result.symbols.find(s => s.name === 'Worker')
    assert.ok(cls)
    assert.equal(cls.kind, 'class')
    const methods = result.symbols.filter(s => s.kind === 'method')
    assert.equal(methods.length, 2)
  })

  it('extracts import edges', async () => {
    const source = `import { foo } from './foo.js'\nimport type { Bar } from '../bar.js'`
    const result = await parseTypeScriptFile('test.ts', source)
    assert.deepEqual(result.imports, ['./foo.js', '../bar.js'])
  })

  it('extracts interfaces and types', async () => {
    const source = `export interface Config { name: string }\ntype Internal = number`
    const result = await parseTypeScriptFile('test.ts', source)
    const iface = result.symbols.find(s => s.name === 'Config')
    assert.ok(iface)
    assert.equal(iface.kind, 'interface')
    assert.equal(iface.exported, true)
    const typ = result.symbols.find(s => s.name === 'Internal')
    assert.ok(typ)
    assert.equal(typ.kind, 'type')
    assert.equal(typ.exported, false)
  })

  it('returns content hash', async () => {
    const result = await parseTypeScriptFile('test.ts', 'const x = 1')
    assert.ok(result.contentHash.length > 0)
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx tsx --test src/repo/__tests__/meridian-parser.test.ts`
预期：FAIL，"Cannot find module '../meridian-parser.js'"

- [ ] **步骤 4：实现解析器**

```typescript
import { createHash } from 'node:crypto'
import type { MeridianSymbol, MeridianEdge, ParseResult, MeridianSymbolKind } from './meridian-types.js'

let Parser: typeof import('web-tree-sitter')['default'] | null = null
let parser: InstanceType<typeof import('web-tree-sitter')['default']> | null = null
let parseCount = 0
const MAX_PARSES_BEFORE_RESET = 250

export async function initParser(): Promise<void> {
  const TreeSitter = (await import('web-tree-sitter')).default
  await TreeSitter.init()
  Parser = TreeSitter
  parser = new TreeSitter()
  const langPath = require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm')
  const lang = await TreeSitter.Language.load(langPath)
  parser.setLanguage(lang)
  parseCount = 0
}

async function ensureParser(): Promise<InstanceType<typeof import('web-tree-sitter')['default']>> {
  if (!parser || parseCount >= MAX_PARSES_BEFORE_RESET) {
    await initParser()
  }
  return parser!
}

function makeId(filePath: string, name: string, line: number): string {
  return `${filePath}:${name}:${line}`
}

export async function parseTypeScriptFile(filePath: string, source: string): Promise<ParseResult> {
  const p = await ensureParser()
  const tree = p.parse(source)
  parseCount++

  const symbols: MeridianSymbol[] = []
  const edges: MeridianEdge[] = []
  const imports: string[] = []
  const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

  function walk(node: import('web-tree-sitter').default.SyntaxNode, parentId?: string): void {
    const row = node.startPosition.row + 1
    const isExported = node.parent?.type === 'export_statement'

    let kind: MeridianSymbolKind | null = null
    let name: string | null = null

    switch (node.type) {
      case 'function_declaration':
        kind = 'function'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'class_declaration':
        kind = 'class'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'interface_declaration':
        kind = 'interface'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'type_alias_declaration':
        kind = 'type'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'enum_declaration':
        kind = 'enum'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'method_definition':
        kind = 'method'
        name = node.childForFieldName('name')?.text ?? null
        break
      case 'lexical_declaration':
      case 'variable_declaration': {
        const declarator = node.namedChildren.find(c => c.type === 'variable_declarator')
        if (declarator) {
          const init = declarator.childForFieldName('value')
          if (init && (init.type === 'arrow_function' || init.type === 'function')) {
            kind = 'function'
          } else {
            kind = 'variable'
          }
          name = declarator.childForFieldName('name')?.text ?? null
        }
        break
      }
      case 'import_statement': {
        const source_node = node.childForFieldName('source')
        if (source_node) {
          const raw = source_node.text.replace(/['"]/g, '')
          if (raw.startsWith('.')) imports.push(raw)
        }
        return
      }
    }

    if (kind && name) {
      const id = makeId(filePath, name, row)
      symbols.push({ id, name, kind, filePath, line: row, exported: isExported, contentHash })
      if (parentId) {
        edges.push({ sourceId: parentId, targetId: id, kind: 'contains', weight: 1.0 })
      }
      for (const child of node.namedChildren) {
        walk(child, id)
      }
      return
    }

    for (const child of node.namedChildren) {
      walk(child, parentId)
    }
  }

  walk(tree.rootNode)
  tree.delete()

  return { filePath, contentHash, symbols, edges, imports }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/repo/__tests__/meridian-parser.test.ts`
预期：5 tests PASS

- [ ] **步骤 6：Commit**

```bash
git add src/repo/meridian-parser.ts src/repo/__tests__/meridian-parser.test.ts package.json package-lock.json
git commit -m "feat(meridian): tree-sitter TypeScript parser with symbol extraction"
```

---

## 任务 3：SQLite 持久化层

**文件：**
- 创建：`src/repo/meridian-db.ts`
- 测试：`src/repo/__tests__/meridian-db.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('meridian db', () => {
  let db: MeridianDb
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-'))
    db = new MeridianDb(dir)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upserts and retrieves symbols', () => {
    db.upsertFile({
      filePath: 'src/foo.ts',
      contentHash: 'abc123',
      symbols: [{ id: 'src/foo.ts:hello:1', name: 'hello', kind: 'function', filePath: 'src/foo.ts', line: 1, exported: true, contentHash: 'abc123' }],
      edges: [],
      imports: ['./bar.js'],
    })
    const symbols = db.getSymbolsForFile('src/foo.ts')
    assert.equal(symbols.length, 1)
    assert.equal(symbols[0]!.name, 'hello')
  })

  it('skips re-parse when hash matches', () => {
    assert.equal(db.needsParse('src/foo.ts', 'hash1'), true)
    db.upsertFile({ filePath: 'src/foo.ts', contentHash: 'hash1', symbols: [], edges: [], imports: [] })
    assert.equal(db.needsParse('src/foo.ts', 'hash1'), false)
    assert.equal(db.needsParse('src/foo.ts', 'hash2'), true)
  })

  it('stores and retrieves edges', () => {
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'h1',
      symbols: [
        { id: 'src/a.ts:A:1', name: 'A', kind: 'class', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
      ],
      edges: [{ sourceId: 'src/a.ts:A:1', targetId: 'src/b.ts:B:1', kind: 'imports', weight: 1.0 }],
      imports: ['./b.js'],
    })
    const edges = db.getEdgesFrom('src/a.ts:A:1')
    assert.equal(edges.length, 1)
    assert.equal(edges[0]!.targetId, 'src/b.ts:B:1')
  })

  it('records access and returns access count', () => {
    db.recordAccess('src/foo.ts')
    db.recordAccess('src/foo.ts')
    const count = db.getAccessCount('src/foo.ts')
    assert.equal(count, 2)
  })

  it('returns neighbors within N hops', () => {
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [{ id: 'a:X:1', name: 'X', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [{ sourceId: 'a:X:1', targetId: 'b:Y:1', kind: 'calls', weight: 1.0 }],
      imports: [],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [{ id: 'b:Y:1', name: 'Y', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' }],
      edges: [{ sourceId: 'b:Y:1', targetId: 'c:Z:1', kind: 'calls', weight: 1.0 }],
      imports: [],
    })
    const neighbors = db.getNeighborIds('a:X:1', 2)
    assert.ok(neighbors.has('b:Y:1'))
    assert.ok(neighbors.has('c:Z:1'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/repo/__tests__/meridian-db.test.ts`
预期：FAIL

- [ ] **步骤 3：实现数据库层**

```typescript
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { ParseResult, MeridianSymbol, MeridianEdge } from './meridian-types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY(source_id, target_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

CREATE TABLE IF NOT EXISTS access_log (
  file_path TEXT NOT NULL,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_file ON access_log(file_path);
`

export class MeridianDb {
  private db: Database.Database

  constructor(stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const dbPath = join(stateDir, 'meridian.db')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 3000')
    this.db.exec(SCHEMA)
  }

  needsParse(filePath: string, contentHash: string): boolean {
    const row = this.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath) as { content_hash: string } | undefined
    return !row || row.content_hash !== contentHash
  }

  upsertFile(result: ParseResult): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(result.filePath)
      this.db.prepare('DELETE FROM edges WHERE source_id LIKE ?').run(`${result.filePath}:%`)
      this.db.prepare('INSERT OR REPLACE INTO files (path, content_hash) VALUES (?, ?)').run(result.filePath, result.contentHash)

      const insertSym = this.db.prepare('INSERT OR REPLACE INTO symbols (id, name, kind, file_path, line, exported, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const s of result.symbols) {
        insertSym.run(s.id, s.name, s.kind, s.filePath, s.line, s.exported ? 1 : 0, s.contentHash)
      }

      const insertEdge = this.db.prepare('INSERT OR REPLACE INTO edges (source_id, target_id, kind, weight) VALUES (?, ?, ?, ?)')
      for (const e of result.edges) {
        insertEdge.run(e.sourceId, e.targetId, e.kind, e.weight)
      }

      for (const imp of result.imports) {
        const firstSymbol = result.symbols[0]
        if (firstSymbol) {
          insertEdge.run(firstSymbol.id, `${imp}:*:0`, 'imports', 1.0)
        }
      }
    })
    tx()
  }

  getSymbolsForFile(filePath: string): MeridianSymbol[] {
    return (this.db.prepare('SELECT * FROM symbols WHERE file_path = ?').all(filePath) as Array<Record<string, unknown>>).map(row => ({
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as MeridianSymbol['kind'],
      filePath: row.file_path as string,
      line: row.line as number,
      exported: (row.exported as number) === 1,
      contentHash: row.content_hash as string,
    }))
  }

  getEdgesFrom(symbolId: string): MeridianEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(symbolId) as Array<Record<string, unknown>>).map(row => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as MeridianEdge['kind'],
      weight: row.weight as number,
    }))
  }

  recordAccess(filePath: string): void {
    this.db.prepare('INSERT INTO access_log (file_path) VALUES (?)').run(filePath)
  }

  getAccessCount(filePath: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM access_log WHERE file_path = ?').get(filePath) as { cnt: number }
    return row.cnt
  }

  getNeighborIds(startId: string, maxHops: number): Set<string> {
    const visited = new Set<string>()
    let frontier = new Set([startId])
    for (let hop = 0; hop < maxHops; hop++) {
      const next = new Set<string>()
      for (const id of frontier) {
        const edges = this.db.prepare('SELECT target_id FROM edges WHERE source_id = ? UNION SELECT source_id FROM edges WHERE target_id = ?').all(id, id) as Array<{ target_id?: string; source_id?: string }>
        for (const e of edges) {
          const neighbor = (e.target_id ?? e.source_id)!
          if (!visited.has(neighbor) && neighbor !== startId) {
            visited.add(neighbor)
            next.add(neighbor)
          }
        }
      }
      frontier = next
    }
    return visited
  }

  getStats(): { files: number; symbols: number; edges: number } {
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }).cnt
    const symbols = (this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt
    const edges = (this.db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt
    return { files, symbols, edges }
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/repo/__tests__/meridian-db.test.ts`
预期：5 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/repo/meridian-db.ts src/repo/__tests__/meridian-db.test.ts
git commit -m "feat(meridian): SQLite persistence layer with content-hash incremental"
```

---

## 任务 4：图查询（Spreading Activation + Token Budget）

**文件：**
- 创建：`src/repo/meridian-graph.ts`
- 测试：`src/repo/__tests__/meridian-graph.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spreadingActivation, buildRepoMap } from '../meridian-graph.js'
import { MeridianDb } from '../meridian-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('meridian graph', () => {
  let db: MeridianDb
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-graph-'))
    db = new MeridianDb(dir)
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [
        { id: 'a:foo:1', name: 'foo', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
        { id: 'a:bar:5', name: 'bar', kind: 'function', filePath: 'src/a.ts', line: 5, exported: true, contentHash: 'h1' },
      ],
      edges: [{ sourceId: 'a:foo:1', targetId: 'b:baz:1', kind: 'calls', weight: 1.0 }],
      imports: ['./b.js'],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [
        { id: 'b:baz:1', name: 'baz', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' },
      ],
      edges: [{ sourceId: 'b:baz:1', targetId: 'c:qux:1', kind: 'calls', weight: 1.0 }],
      imports: ['./c.js'],
    })
    db.upsertFile({
      filePath: 'src/c.ts', contentHash: 'h3',
      symbols: [
        { id: 'c:qux:1', name: 'qux', kind: 'function', filePath: 'src/c.ts', line: 1, exported: true, contentHash: 'h3' },
      ],
      edges: [],
      imports: [],
    })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spreading activation returns scores decaying with distance', () => {
    const scores = spreadingActivation(db, 'src/a.ts', { maxHops: 3, decay: 0.5 })
    assert.ok(scores.get('src/a.ts')! > scores.get('src/b.ts')!)
    assert.ok(scores.get('src/b.ts')! > scores.get('src/c.ts')!)
  })

  it('seed file has score 1.0', () => {
    const scores = spreadingActivation(db, 'src/a.ts', { maxHops: 2, decay: 0.5 })
    assert.equal(scores.get('src/a.ts'), 1.0)
  })

  it('buildRepoMap returns entries sorted by score', () => {
    const result = buildRepoMap(db, 'src/a.ts', { maxHops: 3, decay: 0.5, maxTokens: 2000 })
    assert.ok(result.entries.length >= 2)
    assert.equal(result.entries[0]!.filePath, 'src/a.ts')
    for (let i = 1; i < result.entries.length; i++) {
      assert.ok(result.entries[i - 1]!.score >= result.entries[i]!.score)
    }
  })

  it('buildRepoMap respects token budget', () => {
    const result = buildRepoMap(db, 'src/a.ts', { maxHops: 3, decay: 0.5, maxTokens: 50 })
    assert.ok(result.entries.length <= 3)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/repo/__tests__/meridian-graph.test.ts`
预期：FAIL

- [ ] **步骤 3：实现图查询**

```typescript
import type { MeridianDb } from './meridian-db.js'
import type { RepoMapEntry, RepoMapResult } from './meridian-types.js'

export interface ActivationOptions {
  maxHops: number
  decay: number
}

export interface RepoMapOptions extends ActivationOptions {
  maxTokens: number
}

export function spreadingActivation(
  db: MeridianDb,
  seedFile: string,
  opts: ActivationOptions,
): Map<string, number> {
  const scores = new Map<string, number>()
  scores.set(seedFile, 1.0)

  const seedSymbols = db.getSymbolsForFile(seedFile)
  let frontier = seedSymbols.map(s => s.id)

  for (let hop = 0; hop < opts.maxHops; hop++) {
    const decayFactor = Math.pow(opts.decay, hop + 1)
    const nextFrontier: string[] = []

    for (const symbolId of frontier) {
      const edges = db.getEdgesFrom(symbolId)
      for (const edge of edges) {
        const targetSymbols = db.getSymbolById?.(edge.targetId)
        const targetFile = edge.targetId.split(':')[0]!
        if (targetFile && !targetFile.includes('*')) {
          const existing = scores.get(targetFile) ?? 0
          const addition = decayFactor * edge.weight
          scores.set(targetFile, Math.max(existing, addition))
          nextFrontier.push(edge.targetId)
        }
      }
    }
    frontier = nextFrontier
  }

  return scores
}

const TOKENS_PER_SYMBOL_LINE = 25

export function buildRepoMap(
  db: MeridianDb,
  seedFile: string,
  opts: RepoMapOptions,
): RepoMapResult {
  const scores = spreadingActivation(db, seedFile, opts)
  const stats = db.getStats()

  const entries: RepoMapEntry[] = []
  for (const [filePath, score] of scores) {
    const symbols = db.getSymbolsForFile(filePath)
    entries.push({
      filePath,
      symbols: symbols.map(s => ({ name: s.name, kind: s.kind, line: s.line })),
      score,
    })
  }

  entries.sort((a, b) => b.score - a.score)

  let tokenCount = 0
  let cutoff = entries.length
  for (let i = 0; i < entries.length; i++) {
    const entryTokens = entries[i]!.symbols.length * TOKENS_PER_SYMBOL_LINE + 10
    if (tokenCount + entryTokens > opts.maxTokens) {
      cutoff = i
      break
    }
    tokenCount += entryTokens
  }

  return {
    entries: entries.slice(0, cutoff),
    totalSymbols: stats.symbols,
    graphSize: stats.files,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/repo/__tests__/meridian-graph.test.ts`
预期：4 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/repo/meridian-graph.ts src/repo/__tests__/meridian-graph.test.ts
git commit -m "feat(meridian): spreading activation graph query with token budget"
```

---

## 任务 5：Facade（MeridianIndexer）

**文件：**
- 创建：`src/repo/meridian-indexer.ts`

- [ ] **步骤 1：实现 facade**

```typescript
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { MeridianDb } from './meridian-db.js'
import { parseTypeScriptFile, initParser } from './meridian-parser.js'
import { buildRepoMap, spreadingActivation } from './meridian-graph.js'
import type { RepoMapResult, RepoMapOptions } from './meridian-types.js'

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const IGNORE_PATTERNS = ['node_modules', 'dist', '.git', '.rivet']

export class MeridianIndexer {
  private db: MeridianDb
  private initialized = false
  private indexing = new Set<string>()

  constructor(private cwd: string, stateDir?: string) {
    const dir = stateDir ?? resolve(cwd, '.rivet')
    this.db = new MeridianDb(dir)
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await initParser()
      this.initialized = true
    }
  }

  async indexFile(filePath: string): Promise<void> {
    if (this.indexing.has(filePath)) return
    if (!this.isIndexable(filePath)) return

    const absPath = resolve(this.cwd, filePath)
    if (!existsSync(absPath)) return

    const source = readFileSync(absPath, 'utf-8')
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)

    if (!this.db.needsParse(filePath, hash)) {
      this.db.recordAccess(filePath)
      return
    }

    await this.ensureInit()
    this.indexing.add(filePath)

    try {
      const result = await parseTypeScriptFile(filePath, source)
      this.db.upsertFile(result)
      this.db.recordAccess(filePath)

      // 1-hop expand: parse direct imports
      for (const imp of result.imports) {
        const resolved = this.resolveImport(filePath, imp)
        if (resolved && !this.indexing.has(resolved)) {
          await this.indexFile(resolved)
        }
      }
    } finally {
      this.indexing.delete(filePath)
    }
  }

  async invalidateFile(filePath: string): Promise<void> {
    if (!this.isIndexable(filePath)) return
    const absPath = resolve(this.cwd, filePath)
    if (!existsSync(absPath)) return

    await this.ensureInit()
    const source = readFileSync(absPath, 'utf-8')
    const result = await parseTypeScriptFile(filePath, source)
    this.db.upsertFile(result)
  }

  query(seedFile: string, opts?: Partial<RepoMapOptions>): RepoMapResult {
    return buildRepoMap(this.db, seedFile, {
      maxHops: opts?.maxHops ?? 3,
      decay: opts?.decay ?? 0.5,
      maxTokens: opts?.maxTokens ?? 2000,
    })
  }

  getStats() {
    return this.db.getStats()
  }

  close(): void {
    this.db.close()
  }

  private isIndexable(filePath: string): boolean {
    if (IGNORE_PATTERNS.some(p => filePath.includes(p))) return false
    return TS_EXTENSIONS.some(ext => filePath.endsWith(ext))
  }

  private resolveImport(fromFile: string, importPath: string): string | null {
    const baseDir = dirname(fromFile)
    const candidates = TS_EXTENSIONS.flatMap(ext => [
      resolve(this.cwd, baseDir, importPath + ext),
      resolve(this.cwd, baseDir, importPath, 'index' + ext),
    ])
    for (const c of candidates) {
      if (existsSync(c)) {
        const relative = c.slice(resolve(this.cwd).length + 1)
        return relative
      }
    }
    // Try without extension change (already has extension)
    const direct = resolve(this.cwd, baseDir, importPath)
    if (existsSync(direct)) return direct.slice(resolve(this.cwd).length + 1)
    return null
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/repo/meridian-indexer.ts
git commit -m "feat(meridian): indexer facade with 1-hop expand and import resolution"
```

---

## 任务 6：PostTool Hook

**文件：**
- 创建：`src/agent/hooks/meridian-hook.ts`

- [ ] **步骤 1：实现 hook**

```typescript
import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { MeridianIndexer } from '../../repo/meridian-indexer.js'

export interface MeridianHookDeps {
  getIndexer: () => MeridianIndexer | null
}

export function createMeridianHook(deps: MeridianHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'meridian-index',
    async run(_ctx, tool) {
      const indexer = deps.getIndexer()
      if (!indexer) return

      if (tool.name === 'read_file' && tool.target && tool.success) {
        await indexer.indexFile(tool.target)
      }

      if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target && tool.success) {
        await indexer.invalidateFile(tool.target)
      }
    },
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/agent/hooks/meridian-hook.ts
git commit -m "feat(meridian): postTool hook triggers index on read/edit"
```

---

## 任务 7：repo_map Tool

**文件：**
- 创建：`src/tools/repo-map.ts`
- 测试：`src/tools/__tests__/repo-map.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRepoMapTool } from '../repo-map.js'
import { MeridianIndexer } from '../../repo/meridian-indexer.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initParser } from '../../repo/meridian-parser.js'

describe('repo_map tool', () => {
  let dir: string
  let indexer: MeridianIndexer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'repomap-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'main.ts'), 'export function main() {}\nimport { helper } from "./helper.js"')
    writeFileSync(join(dir, 'src', 'helper.ts'), 'export function helper() {}')
    await initParser()
    indexer = new MeridianIndexer(dir, join(dir, '.rivet'))
    await indexer.indexFile('src/main.ts')
  })

  afterEach(() => {
    indexer.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns related files from seed', async () => {
    const tool = createRepoMapTool(() => indexer)
    const result = await tool.execute({
      input: { from_file: 'src/main.ts' },
      toolUseId: 'test-1',
      cwd: dir,
    })
    assert.ok(result.content.includes('src/main.ts'))
    assert.equal(result.isError, undefined)
  })

  it('returns error when indexer unavailable', async () => {
    const tool = createRepoMapTool(() => null)
    const result = await tool.execute({
      input: { from_file: 'src/main.ts' },
      toolUseId: 'test-2',
      cwd: dir,
    })
    assert.equal(result.isError, true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/repo-map.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 tool**

```typescript
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'

const DEFINITION: ToolDefinition = {
  name: 'repo_map',
  description: 'Query the code graph to find files and symbols related to a given file. Returns a ranked list of related code based on import/call relationships and access patterns. Use this to understand code structure before reading files.',
  input_schema: {
    type: 'object',
    properties: {
      from_file: { type: 'string', description: 'The file path to search from (relative to project root)' },
      max_tokens: { type: 'number', default: 2000, description: 'Maximum token budget for the response' },
      max_hops: { type: 'number', default: 3, description: 'Maximum graph traversal depth' },
    },
    required: ['from_file'],
  },
}

export function createRepoMapTool(getIndexer: () => MeridianIndexer | null): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const indexer = getIndexer()
      if (!indexer) {
        return { content: 'Meridian index not available. Read some files first to build the graph.', isError: true }
      }

      const input = params.input as { from_file: string; max_tokens?: number; max_hops?: number }
      const result = indexer.query(input.from_file, {
        maxTokens: input.max_tokens ?? 2000,
        maxHops: input.max_hops ?? 3,
      })

      if (result.entries.length === 0) {
        return { content: `No graph data for ${input.from_file}. File may not have been indexed yet.` }
      }

      const lines: string[] = [`Graph: ${result.graphSize} files, ${result.totalSymbols} symbols\n`]
      for (const entry of result.entries) {
        lines.push(`${entry.filePath}:`)
        for (const sym of entry.symbols) {
          const prefix = sym.kind === 'function' || sym.kind === 'method' ? 'fn' : sym.kind
          lines.push(`  ${prefix} ${sym.name} (L${sym.line})`)
        }
        lines.push('')
      }

      return { content: lines.join('\n') }
    },
    requiresApproval() { return false },
    isConcurrencySafe() { return true },
    isEnabled() { return true },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/repo-map.test.ts`
预期：2 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/repo-map.ts src/tools/__tests__/repo-map.test.ts
git commit -m "feat(meridian): repo_map tool for agent-callable graph queries"
```

---

## 任务 8：集成到 Agent Loop

**文件：**
- 修改：`src/agent/loop.ts`（添加 MeridianIndexer 成员、hook 注册、tool 注册）

- [ ] **步骤 1：在 loop.ts 中添加 import 和成员**

在 loop.ts 的 import 区域添加：
```typescript
import { MeridianIndexer } from '../repo/meridian-indexer.js'
import { createMeridianHook } from './hooks/meridian-hook.js'
import { createRepoMapTool } from '../tools/repo-map.js'
```

在 AgentLoop class 中添加成员：
```typescript
private meridianIndexer: MeridianIndexer | null = null
```

- [ ] **步骤 2：在构造函数中初始化 indexer**

在 AgentLoop 构造函数中（其他 hook 注册之后）：
```typescript
this.meridianIndexer = new MeridianIndexer(this.cwd, join(this.cwd, '.rivet'))
this.runtimeHooks.register(createMeridianHook({
  getIndexer: () => this.meridianIndexer,
}))
this.toolRegistry.register(createRepoMapTool(() => this.meridianIndexer))
```

- [ ] **步骤 3：运行 typecheck**

运行：`npm run typecheck`
预期：0 errors

- [ ] **步骤 4：运行全量测试**

运行：`npm test`
预期：所有现有测试通过，无回归

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(meridian): integrate indexer + hook + tool into agent loop"
```

---

## 自检结果

1. **规格覆盖度**：
   - ✅ tree-sitter 解析（任务 2）
   - ✅ SQLite 持久化 + content hash 增量（任务 3）
   - ✅ spreading activation + token budget（任务 4）
   - ✅ 1-hop 预展开（任务 5 的 indexFile）
   - ✅ postTool hook 触发（任务 6）
   - ✅ repo_map tool（任务 7）
   - ✅ agent loop 集成（任务 8）

2. **占位符扫描**：无 TODO/待定/后续实现

3. **类型一致性**：
   - `ParseResult` 在任务 1 定义，任务 2/3/5 使用 — 一致
   - `MeridianDb` 在任务 3 定义，任务 4/5 使用 — 一致
   - `RepoMapResult`/`RepoMapOptions` 在任务 1 定义，任务 4/5/7 使用 — 一致
   - `MeridianIndexer` 在任务 5 定义，任务 6/7/8 使用 — 一致
