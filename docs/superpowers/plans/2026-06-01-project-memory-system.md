# Project Memory System — 设计方案

> 状态：**P1-P3 已实施，待补测试 + 修复已知问题** | 作者：天枢 | 日期：2026-06-01
>
> 本文档面向多用户场景（开源/闭源、团队协作），不假设单人使用。

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| P1：存储层 | ✅ 已实施 | `project-memory-writer.ts` + `project-memory-loader.ts`（commit 079a05d） |
| P2：注入层 | ✅ 已实施 | `volatile-snapshot.ts` + `volatile.ts`（commit 079a05d） |
| P3：写入接入 | ✅ 已实施 + 已修复 | tool-pipeline.ts batch compact（commit f86305f）+ remember.ts cwd 传递（commit e1407b3） |
| 测试 | ❌ 未补 | `project-memory-writer.test.ts` + `project-memory-loader.test.ts` 未写 |
| 并发安全 | ❌ 未验证 | 多会话并发写同一个 memory.jsonl 未处理 |
| claim-extractor 升级 | ❌ 未做 | commit fact / user_constraint 仍为 session scope，未升级为 project |

## 1. 问题定义

**现状**：项目有 5 套记忆机制，但没有一套真正"自动注入 prompt"：

| 机制 | 存储位置 | 自动注入？ | 问题 |
|------|----------|-----------|------|
| Dream → project-memory.md | `.rivet/knowledge/project-memory.md` | ❌ 不注入 | 写入门控太严（5 个 curated criteria 匹配才写），且与 Dream 混在一起 |
| claim-store (session) | `.rivet/sessions/<id>.claims.jsonl` | ✅ 部分注入 | 仅 session 级别，会话结束即消亡 |
| claim-store (durable) | 同上 | ❌ 不注入 | 需要模型主动 recall，经常不调 |
| session-memory | `.rivet/sessions/<id>.memory.json` | ✅ 注入 | 仅当轮有效，不跨会话 |
| remember/recall 工具 | claim-store | ❌ 需主动调 | 模型经常不调 |

**核心矛盾**：项目决策、架构约束、用户偏好存在 `.rivet/knowledge/project-memory.md` 里（6.8KB），但这个文件：
1. **不进入 prompt** — volatile-snapshot.ts 只读 AGENTS.md + .rivet.md，不读 knowledge 目录
2. **写入靠 Dream** — Dream 的写入门控要求 5 个高标 criteria 匹配，大量有价值信息进不来
3. **recall 需主动调用** — 模型经常不调 recall 工具，记忆形同虚设

## 2. 设计目标

**一句话**：项目架构决策和约束自动注入每轮 prompt，无需模型主动 recall。

**量化指标**：
- 注入成本：~1.7K tokens（当前 project-memory.md），占 128K 上下文窗口的 **1.3%**
- 因为注入 frozen base（prefix 缓存覆盖），**turn 2 起边际 token 成本 = 0**
- 写入门控放宽：从"5 curated criteria 匹配"改为"任何 scope=project 的 claim 自动持久化"

## 3. 架构设计

### 3.1 核心思路：Memory 与 Dream 分离

当前架构把"记忆写入"绑在 Dream 上（`src/agent/dream.ts`）。这是错的：
- Dream 是会话结束时的蒸馏管线，职责是提炼 curated 知识
- Memory 是实时写入 + 自动注入的系统，职责是确保关键信息不丢

**新架构**：

```
写入路径（实时，per-turn）:
  tool-pipeline.ts → extractClaims → claim-store.propose()
                                              ↓ (如果 scope=project)
                                    project-memory-writer.ts → .rivet/knowledge/memory.jsonl
                                              ↓
                                    project-memory-loader.ts → 自动 trim/compact → 注入 frozen volatile block

读取路径（每轮自动，无需 recall）:
  volatile-snapshot.ts → readRivetMd() + readProjectMemory() → frozen volatile block
  PromptEngine → frozen base 包含 memory → prefix cache 覆盖

Dream（会话结束时，保持不变）:
  dream.ts → 蒸馏 curated 知识 → .rivet/knowledge/project-memory.md（仅做归档/备份）
```

### 3.2 新增文件

#### `src/context/project-memory-writer.ts` (~100 行)

职责：将 scope=project 的 claim 实时追加到 `.rivet/knowledge/memory.jsonl`

```typescript
interface MemoryEntry {
  id: string           // claim.id
  kind: ContextClaimKind
  text: string
  confidence: number
  createdAt: number
  source: string       // 'tool:read_file' | 'tool:commit' | 'model:remember' | 'user:constraint'
}

// 核心接口
function appendProjectMemory(cwd: string, claim: ContextClaim): void
function compactProjectMemory(cwd: string, maxEntries: number): number  // 去重 + 裁剪
```

- 存储位置：`.rivet/knowledge/memory.jsonl`（每行一个 JSON）
- 最大条目数：200 条（超出时按 fitness 排序裁剪）
- 文件大小上限：16KB（~4K tokens）
- 触发时机：tool-pipeline.ts 里 claim-store.propose() 之后，如果 claim.scope === 'project'

#### `src/context/project-memory-loader.ts` (~80 行)

职责：加载并渲染项目记忆为 prompt 块

```typescript
interface ProjectMemoryBlock {
  content: string      // XML 格式的记忆块
  tokenEstimate: number
  entryCount: number
}

function loadProjectMemory(cwd: string): ProjectMemoryBlock
```

- 读取 `.rivet/knowledge/memory.jsonl`
- 按 confidence + fitness 排序
- 截断到 4K tokens 以内
- 输出格式：
```xml
<project-memory entries="12" bytes="3800">
  <memory kind="decision" confidence="0.95">use node:test + node:assert/strict, never jest or vitest</memory>
  <memory kind="project_rule" confidence="1.0">TypeScript strict mode, noUncheckedIndexedAccess: true</memory>
  ...
</project-memory>
```

### 3.3 修改文件

#### 修改 1：`src/prompt/volatile-snapshot.ts`

在 `createVolatileSnapshot()` 中增加 project memory 加载：

```typescript
// 现有：加载 AGENTS.md + .rivet.md
// 新增：加载 .rivet/knowledge/memory.jsonl → 注入到 sessionMemoryBlock 或新字段
```

- 新增 `projectMemoryBlock?: string` 字段到 VolatileContext
- 在 frozen base 中渲染（prefix 缓存覆盖）

#### 修改 2：`src/prompt/volatile.ts`

- `buildStableVolatileBlock()` 渲染 projectMemoryBlock
- 放在 `<project-instructions>` 块之后

#### 修改 3：`src/agent/tool-pipeline.ts`

在 claim 提取后增加 project memory 写入：

```typescript
// 现有：extractClaimsFromToolResult → claim-store.propose()
// 新增：如果 claim.scope === 'project' → appendProjectMemory()
```

#### 修改 4：`src/tools/remember.ts`

remember 工具写入 claim 时，如果 scope=project，同步写入 project memory：

```typescript
// 现有：store.propose()
// 新增：if (scope === 'project') appendProjectMemory(cwd, claim)
```

### 3.4 记忆条目来源（写入时机）

| 来源 | 触发条件 | scope | kind |
|------|---------|-------|------|
| remember 工具 | 模型主动调用，scope=project | project | 由模型指定 |
| tool-pipeline 提取 | read_file 发现导出符号 | session | file_observation（**不升级**） |
| tool-pipeline 提取 | commit 成功 | session → **升级为 project** | decision |
| 用户约束提取 | AnchorRegistry 匹配约束 | **project** | user_constraint |
| 项目规则加载 | `.rivet/rules/*.md` | project | project_rule |

**关键决策**：
- file_observation 保持 session 级别（太多、太杂）
- commit fact 自动升级为 project 级别（架构决策应该持久化）
- user_constraint 自动写入 project 级别（用户约束必须持久化）
- project_rule 本来就是 project 级别

### 3.5 与 Dream 的关系

Dream 保持不变，继续做它的 curated 蒸馏。但 Dream 不再是 project memory 的唯一写入路径。

| | Project Memory（新） | Dream（现有） |
|---|---|---|
| 写入时机 | 实时，per-turn | 会话结束时 |
| 存储位置 | `.rivet/knowledge/memory.jsonl` | `.rivet/knowledge/project-memory.md` |
| 写入门控 | scope=project 即写入 | 5 curated criteria 匹配 |
| 是否注入 prompt | ✅ 自动注入 frozen block | ❌ 不注入 |
| 条目上限 | 200 条 / 16KB | 8KB |
| 格式 | JSONL（结构化） | Markdown（人类可读） |

两者互补：project memory 是机器的实时记忆，Dream 是人类的归档笔记。

## 4. Token 成本分析

```
当前 frozen base（无 memory）：~3.6K tokens
新增 project memory block：    ~1.7K tokens（最大 4K）
新的 frozen base：              ~5.3K tokens = 4.1% of 128K

Prefix cache 覆盖：
  Turn 1: 5.3K tokens（新写入）
  Turn 2+: 0 tokens（prefix cache 命中，边际成本为零）
```

**结论**：边际 token 成本为零，因为 project memory 进入 frozen volatile block（prefix 缓存稳定区域）。

## 5. 实施计划

| 阶段 | 改动 | 文件数 | 预计行数 |
|------|------|--------|---------|
| P1：存储层 | project-memory-writer.ts + project-memory-loader.ts + 测试 | 3 | ~350 |
| P2：注入层 | volatile-snapshot.ts + volatile.ts 修改 | 2 | ~40 |
| P3：写入接入 | tool-pipeline.ts + remember.ts 修改 | 2 | ~30 |
| P4：集成验证 | typecheck + 现有测试通过 + 新增集成测试 | 1 | ~80 |
| **合计** | | **8** | **~500** |

### P1 详细设计

**`src/context/project-memory-writer.ts`**：

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextClaim } from './claims.js'

const MAX_ENTRIES = 200
const MAX_FILE_SIZE = 16_384  // 16KB

export function appendProjectMemory(cwd: string, claim: ContextClaim): void {
  const dir = join(cwd, '.rivet', 'knowledge')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'memory.jsonl')
  
  const entry = {
    id: claim.id,
    kind: claim.kind,
    text: claim.text,
    confidence: claim.confidence,
    createdAt: claim.createdAt,
    source: claim.evidence[0]?.summary ?? 'unknown',
  }
  
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
}

export function compactProjectMemory(cwd: string): number {
  const path = join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
  if (!existsSync(path)) return 0
  
  const lines = readFileSync(path, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  
  // Deduplicate by id
  const seen = new Map<string, typeof lines[0]>()
  for (const entry of lines) {
    seen.set(entry.id, entry)
  }
  
  // Sort by confidence desc, keep top MAX_ENTRIES
  const kept = [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)
  
  writeFileSync(path, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
  return lines.length - kept.length
}
```

**`src/context/project-memory-loader.ts`**：

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RENDER_CHARS = 4_000  // ~1K tokens

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
}

export interface ProjectMemoryBlock {
  content: string
  entryCount: number
  tokenEstimate: number
}

export function loadProjectMemory(cwd: string): ProjectMemoryBlock {
  const path = join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
  if (!existsSync(path)) return { content: '', entryCount: 0, tokenEstimate: 0 }
  
  const entries: MemoryEntry[] = readFileSync(path, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter((e): e is MemoryEntry => e !== null)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
  
  if (entries.length === 0) return { content: '', entryCount: 0, tokenEstimate: 0 }
  
  let budget = MAX_RENDER_CHARS
  const rendered: string[] = []
  let used = 0
  
  for (const entry of entries) {
    const line = `  <m kind="${entry.kind}" c="${entry.confidence.toFixed(2)}">${escapeXml(entry.text)}</m>`
    if (used + line.length > budget) break
    rendered.push(line)
    used += line.length
  }
  
  const content = `<project-memory entries="${rendered.length}">\n${rendered.join('\n')}\n</project-memory>`
  return {
    content,
    entryCount: rendered.length,
    tokenEstimate: Math.ceil(content.length / 4),
  }
}

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
```

### P2 详细设计

**`src/prompt/volatile-snapshot.ts`** 修改：

```typescript
// 新增 import
import { loadProjectMemory } from '../context/project-memory-loader.js'

export interface SnapshotInput {
  cwd: string
  getGitStatus?: () => string | undefined
  rivetMd?: string
  sessionMemoryBlock?: string
  workingSet?: string[]
  activeDomain?: VolatileContext['activeDomain']
  projectMemoryBlock?: string  // ← 新增
}

export function createVolatileSnapshot(input: SnapshotInput): VolatileContext {
  // ... existing code ...
  
  // 新增：加载 project memory
  const projectMemoryBlock = input.projectMemoryBlock 
    ?? loadProjectMemory(input.cwd).content  // ← 自动加载
  
  return Object.freeze({
    // ... existing fields ...
    projectMemoryBlock,  // ← 新增字段
  }) as VolatileContext
}
```

**`src/prompt/volatile.ts`** 修改 `buildStableVolatileBlock()`：

```typescript
// 在 rivetMd 块之后追加 project memory
if (ctx.projectMemoryBlock) {
  parts.push(ctx.projectMemoryBlock)
}
```

### P3 详细设计

**`src/agent/tool-pipeline.ts`** 在 claim 提取后：

```typescript
// 现有代码（~line 755）：
for (const proposal of proposals) {
  deps.config.contextClaimStore.propose(proposal)
}
// 新增：
for (const proposal of proposals) {
  if (proposal.scope === 'project') {
    const claim = deps.config.contextClaimStore.listClaims().find(c => c.text === proposal.text)
    if (claim) appendProjectMemory(deps.cwd, claim)
  }
}
```

**`src/tools/remember.ts`** 在 propose 后：

```typescript
// 现有：
const claim = store.propose({ ... })
// 新增：
if ((input.scope ?? 'session') === 'project') {
  // 需要从外部传入 cwd，或通过 ctx 扩展
  appendProjectMemory(ctx?.cwd ?? '', claim)
}
```

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Memory 文件膨胀 | 16KB 上限 + 200 条上限 + compact 去重 |
| 注入太多噪声 | 按 confidence 排序 + 4K token 渲染上限 |
| 写入频繁影响性能 | appendFileSync（同步但轻量，每轮最多写 1-2 条） |
| 与 Dream 冲突 | 两者写不同文件，互不干扰 |
| prefix cache 失效 | Memory 进入 frozen block，只在内容变化时才失效（低频） |

## 7. 并发安全分析（多会话 / 多用户）

### 7.1 当前行为

`appendFileSync` 在 POSIX 系统上对小于 `PIPE_BUF`（4KB）的写入是原子的——单条 JSONL 行通常 < 1KB，所以：
- **两个会话同时 append**：不会出现行交叉（每个 write 是原子的）
- **两个会话同时 compact**：可能丢数据（read-rewrite 非原子）——但 compact 只在超出 200 条时触发，频率极低

### 7.2 已知风险

| 场景 | 风险等级 | 说明 |
|------|---------|------|
| 两个会话并发 append | ✅ 安全 | O_APPEND + PIPE_BUF 保证原子性 |
| 会话 A append + 会话 B compact 同时发生 | ⚠️ 低风险 | compact 在 read 后 write 时可能覆盖 A 的 append。但 compact 仅在 200 条时触发，概率极低 |
| 多用户共享同一台机器同一个项目 | ⚠️ 低风险 | 同上，文件权限需保证可读写 |
| 多用户各自 fork 的项目 | ✅ 安全 | 各自独立的 .rivet/knowledge/memory.jsonl |

### 7.3 后续加固方案（可选）

1. **文件锁**：使用 `proper-lockfile` 或 `flock` 在 compact 时加锁
2. **每个会话写独立文件**：`.rivet/knowledge/memory-<session>.jsonl`，loader 合并读取
3. **WAL 模式**：类似 claim-store 的事件溯源，但当前规模不需要

### 7.4 多用户 / 团队场景

| 场景 | 当前支持度 | 后续需要 |
|------|-----------|---------|
| 单用户多会话（同一台机器） | ✅ 支持 | 并发 compact 时可能丢少量条目，可接受 |
| 团队共享 Git 仓库 | ⚠️ 部分 | memory.jsonl 可被 .gitignore 排除；团队知识库需要服务端方案 |
| 开源项目贡献者 | ❌ 不支持 | 需要全局/用户级 memory 配置（~/.rivet/knowledge/） |
| 企业部署 | ❌ 不支持 | 需要 centralized memory service（数据库 + API） |

**建议**：
- `.rivet/knowledge/memory.jsonl` 加入 `.gitignore`（它是本地缓存，不是团队知识）
- 团队共享知识通过 `AGENTS.md` + `.rivet/rules/*.md`（版本控制的静态知识）
- 未来可加 `~/.config/rivet/knowledge/` 作为用户级全局 memory

## 8. 已知待办（下个会话）

| 优先级 | 项目 | 说明 |
|--------|------|------|
| **P0** | 补测试 | `project-memory-writer.test.ts` + `project-memory-loader.test.ts` |
| **P1** | claim-extractor 升级 | `commitFact` scope 从 `session` → `project`；`user_constraint` 检测逻辑升级 |
| **P1** | 并发安全验证 | 实测两个进程并发 append + compact 的行为 |
| **P2** | .gitignore | 将 `.rivet/knowledge/memory.jsonl` 加入默认 gitignore |
| **P2** | 用户级全局 memory | `~/.config/rivet/knowledge/` 支持 |
| **P3** | Memory 膨胀监控 | 在 TUI 中显示当前 memory 条目数 + token 估算 |
| **P3** | 记忆去噪 | 定期清理过时/低置信度条目（类似 gbrain 的 decay 机制） |

## 9. 不做什么

1. **不做向量检索** — 当前子串匹配够用，4K token 注入量不需要语义搜索
2. **不做 LLM 自动提取** — 保持现有 extractClaimsFromToolResult 的规则提取
3. **不做合成层** — 不需要 gbrain 的 think 管线，直接注入 XML 块
4. **不改 Dream** — Dream 保持独立，继续做它的 curated 归档
5. **不做知识图谱** — 当前项目不需要实体关系推理

## 10. gbrain 参考架构摘要

> gbrain (github.com/garrytan/gbrain) 是一个 645 文件的个人知识库系统，使用 PGLite 数据库。
> 以下是我们参考过的核心机制，以及为什么 Rivet 选择了不同的路径。

| gbrain 机制 | gbrain 实现 | Rivet 选择 | 理由 |
|-------------|------------|-----------|------|
| 事实提取 | LLM 管线（Haiku 抽取 → 矛盾分类 → 衰减评分） | 规则提取（claim-extractor.ts） | 避免 LLM 调用开销；编码 Agent 的 claim 种类有限且可枚举 |
| 存储后端 | PGLite（嵌入式 Postgres + pgvector） | JSONL 文件 | 零依赖；200 条以内不需要索引 |
| 检索方式 | 混合检索（vector + BM25 + RRF 融合排序） | 全量注入 frozen prompt | 4K token 全量注入 < 一次 embedding API 调用的成本 |
| 合成层 | `gbrain think`（检索 → LLM 合成 → 引用 → 空洞分析） | 直接注入 XML 块 | 不需要合成；模型自行理解 XML 结构化记忆 |
| Dream 循环 | 6 阶段（lint → extract → embed → facts → weight → consolidate） | 1 步（compact：去重 + 按置信度裁剪） | 简单场景不需要多阶段管线 |
| 知识图谱 | 实体关系边（attended, works_at, invested_in…） | 无 | 编码 Agent 不需要人物/事件关系推理 |
| 衰减机制 | 置信度随时间指数衰减 + 半衰期配置 | 无（按 confidence 排序，未来可加） | P3 级需求，当前 memory 条目少不需要 |

**关键差异**：gbrain 处理的是非结构化个人知识（笔记、对话、文章），需要 LLM 提取 + 向量检索。Rivet 处理的是结构化编码知识（架构决策、用户约束、项目规则），可以直接规则提取 + 全量注入。
