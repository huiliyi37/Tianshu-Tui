# Project Memory System — 设计方案

> 状态：**P1-P3 已实施；Path C 分层注入已实施；P4-P6 待实施** | 作者：天枢 | 日期：2026-06-01
>
> 本文档面向多用户场景（开源/闭源、团队协作），不假设单人使用。
>
> 2026-06-01 更新：`project-memory-loader.ts` 已改为路径 C（Tier 1 高置信度注入，Tier 2 recall-only），对应分析见 `docs/analysis/2026-06-01-project-memory-architecture-conflict.md`。

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| P1：存储层 | ✅ 已实施 | `project-memory-writer.ts` + `project-memory-loader.ts`（commit 079a05d） |
| P2：注入层 | ✅ 已实施 + 已收窄 | `volatile-snapshot.ts` + `volatile.ts` 仍注入 `loadProjectMemory()`，但 loader 已在 commit 0e35e20 改为 Path C：只渲染 Tier 1 |
| P3：写入接入 | ✅ 已实施 + 已修复 | tool-pipeline.ts batch compact（commit f86305f）+ remember.ts cwd 传递（commit e1407b3） |
| Path C：分层注入 | ✅ 已实施 | Tier 1：`kind ∈ {decision, project_rule, user_constraint}` 且 `confidence >= 0.9` 注入；Tier 2：仅 recall 检索；渲染预算 2K chars（commit 0e35e20） |
| Manifest 契约 | ✅ 已修正 | `.md` curated memory recall-only；`.jsonl` structured memory 分层注入/召回（commit 0e35e20） |
| P4：maybeCompact 持久化 | ❌ 待实施 | 压缩前调用 persistExtractedMemories，防止信息静默丢失 |
| P5：commit fact 升级 | ❌ 待实施 | commitFact scope 从 session → project，提交 fact 将因 `decision + confidence=0.95` 进入 Tier 1 |
| P6：session memory 升级门控 | ❌ 待实施 | 高置信度 decision/failure_pattern 自动升级为 project scope；升级后仍受 Tier 1/Tier 2 分层过滤 |
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

**一句话**：项目级高价值决策和约束自动进入每轮 prompt，无需模型主动 recall；低信号或局部信息保留在 recall 路径，避免 prompt 噪声。

**量化指标**：
- 注入对象：只注入 Tier 1（`decision` / `project_rule` / `user_constraint` 且 `confidence >= 0.9`）
- 注入预算：2K chars（约 500 tokens），占 200K 上下文窗口约 **0.25%**；超出预算按 confidence 与 createdAt 淘汰
- 边际成本：因为注入 frozen base（prefix 缓存覆盖），**turn 2 起边际 token 成本 = 0**；只有 Tier 1 内容变化时会刷新 prefix
- 写入门控：`scope=project` 的 claim 持久化到 `.rivet/knowledge/memory.jsonl`；读取时再按 Tier 1/Tier 2 分层
- recall 保留：所有非 Tier 1 条目（包括 `file_observation` / `verification_fact` / `failure_pattern` 等）仍可由 recall 检索，不自动注入

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
                                    project-memory-loader.ts → Tier 1 过滤 + 2K chars 渲染预算

读取路径（分层）:
  Tier 1（自动注入）:
    volatile-snapshot.ts → loadProjectMemory()
      → kind ∈ {decision, project_rule, user_constraint} AND confidence ≥ 0.9
      → frozen volatile block（prefix cache 覆盖）

  Tier 2（按需召回）:
    recall tool → loadAllProjectMemoryEntries()
      → 搜索全部 memory.jsonl 条目（含 file_observation / verification_fact / failure_pattern）

Dream（会话结束时，保持不变）:
  dream.ts → 蒸馏 curated 知识 → .rivet/knowledge/project-memory.md（recall-only / 人类归档）
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

职责：加载 `.rivet/knowledge/memory.jsonl`，并提供两条读取路径：

1. `loadProjectMemory(cwd)`：只渲染 Tier 1，供 frozen volatile block 自动注入
2. `loadAllProjectMemoryEntries(cwd)`：返回全部条目，供 recall 搜索

```typescript
const MAX_RENDER_CHARS = 2_000
const TIER1_KINDS = new Set(['decision', 'project_rule', 'user_constraint'])
const TIER1_MIN_CONFIDENCE = 0.9

function loadProjectMemory(cwd: string): ProjectMemoryBlock {
  const tier1 = readMemoryEntries(cwd)
    .filter(e => TIER1_KINDS.has(e.kind) && e.confidence >= TIER1_MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)

  // render within MAX_RENDER_CHARS as XML
}

function loadAllProjectMemoryEntries(cwd: string): MemoryEntry[] {
  return readMemoryEntries(cwd)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
}
```

- Tier 1 注入格式：
```xml
<project-memory entries="3">
  <m kind="decision" c="0.95">commit abc123 fix(memory): ...</m>
  <m kind="project_rule" c="1.00">TypeScript strict mode, noUncheckedIndexedAccess: true</m>
</project-memory>
```
- Tier 2 不渲染进 prompt，只通过 recall 检索
- `.rivet/knowledge/project-memory.md` 仍是 curated Markdown，不进入 volatile prompt

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
| 写入门控 | scope=project 即持久化 | 5 curated criteria 匹配 |
| 读取路径 | Tier 1 自动注入；Tier 2 recall-only | recall-only，不注入 prompt |
| 注入门控 | `kind ∈ {decision, project_rule, user_constraint}` 且 `confidence >= 0.9` | 不适用 |
| 渲染预算 | 2K chars（约 500 tokens） | 不适用 |
| 条目上限 | 200 条 / 16KB | 8KB |
| 格式 | JSONL（结构化机器数据） | Markdown（人类可读） |

两者互补：project memory 是机器的实时结构化记忆；Dream 是人类的归档笔记。两者都必须遵守 manifest：`.md` 不进入 volatile prompt，`.jsonl` 只能分层选择后注入。

## 4. Token 成本分析

```
当前 frozen base（无 memory）：~3.6K tokens
新增 Tier 1 project memory：  ≤ ~500 tokens（2K chars 上限）
新的 frozen base：            ~4.1K tokens，约 2.0% of 200K

Prefix cache 覆盖：
  Turn 1 或 Tier 1 变化后: 重新缓存 frozen base
  Turn 2+ 且 Tier 1 未变化: 0 tokens（prefix cache 命中，边际成本为零）
```

**结论**：Path C 把自动注入限制在小而高信号的 Tier 1，避免 079a05d 版本的全量注入噪声；非 Tier 1 条目继续通过 recall 可用。

## 5. 实施计划

| 阶段 | 改动 | 文件数 | 预计行数 |
|------|------|--------|---------|
| P1：存储层 | project-memory-writer.ts + project-memory-loader.ts + 测试 | 3 | ~350 |
| P2：注入层 | volatile-snapshot.ts + volatile.ts 修改 | 2 | ~40 |
| P3：写入接入 | tool-pipeline.ts + remember.ts 修改 | 2 | ~30 |
| P4：集成验证 | typecheck + 现有测试通过 + 新增集成测试 | 1 | ~80 |
| **合计** | | **8** | **~500** |

### P1 详细设计

> 注：下方保留原 P1 草案的主体结构，但 loader 已按 Path C 落地；以 `project-memory-loader.ts` 当前实现为准。

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

**`src/context/project-memory-loader.ts`**（Path C 当前实现）：

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RENDER_CHARS = 2_000 // ~500 tokens for Tier 1 injection
const TIER1_KINDS = new Set(['decision', 'project_rule', 'user_constraint'])
const TIER1_MIN_CONFIDENCE = 0.9

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
}

export function loadProjectMemory(cwd: string): ProjectMemoryBlock {
  const entries = readMemoryEntries(cwd)
  const tier1 = entries
    .filter(e => TIER1_KINDS.has(e.kind) && e.confidence >= TIER1_MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)

  if (tier1.length === 0) return { content: '', entryCount: 0 }

  // render XML within MAX_RENDER_CHARS
}

export function loadAllProjectMemoryEntries(cwd: string): MemoryEntry[] {
  return readMemoryEntries(cwd)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
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
| 注入太多噪声 | Tier 1 kind 白名单 + confidence ≥ 0.9 + 2K chars 渲染上限 |
| 写入频繁影响性能 | appendFileSync（同步但轻量，每轮最多写 1-2 条） |
| 与 Dream 冲突 | 两者写不同文件，且 `.md` recall-only / `.jsonl` 分层注入 |
| prefix cache 失效 | 只有 Tier 1 内容变化才影响 frozen block；Tier 2 写入不改变 prompt |

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

## 8. 记忆保全与跨会话升级（P4-P6）

> 核心问题：当前压缩路径会丢弃大量上下文，而 project memory 是跨会话唯一的持久存储。
> 但 project memory 的写入只靠模型主动调 remember 或 scope=project 的 claim（当前 claim-extractor
> 从不产生 project scope）——导致有价值的信息在压缩时静默丢失。
>
> 以下三项改进建立了"压缩前自动保全 → 跨会话持久化"的桥梁，同时通过门控条件防止噪声膨胀。

## 8.1 Path C 置信度审计（已落地）

`project-memory-loader.ts` 当前只把以下条目渲染进 `<project-memory>`：

```typescript
kind ∈ { decision, project_rule, user_constraint }
AND confidence >= 0.9
```

| 来源 | kind | confidence | scope | Tier 1 资格 | 说明 |
|------|------|------------|-------|-------------|------|
| `claim-extractor.ts` commitFact（P5 待实施） | decision | 0.95 | project | ✅ | 提交 fact 升级后会自动注入 |
| `rules-loader.ts` | project_rule | 1.0 | project | ✅ | `.rivet/rules/*.md` 项目规则 |
| `remember.ts` 主动记录 | 用户指定 | 默认 0.9 | project | ✅/❌ | 只有 decision/project_rule/user_constraint 达标 |
| verification fact | verification_fact | 0.9 | session | ❌ | kind 不在 Tier 1，recall-only |
| failure pattern | failure_pattern | 0.8 | session/project | ❌ | 默认低于门槛且 kind 不在 Tier 1，recall-only |
| file observation | file_observation | 0.6 | session | ❌ | 局部信息，recall-only |

**判断标准**：只有“会改变未来 agent 决策”的规则、约束、决策进入 prompt；“只在某个文件/某次验证/某次失败相关”的事实留给 recall。

### P4 — maybeCompact 压缩前持久化（解决 200K 窗口信息丢失）

**现状**：`persistExtractedMemories` 只在 emergency 路径（enforceContextCeiling 95%、trySessionSplit 86%）调用。标准 Tier 1/2 压缩路径 `maybeCompact` 不做任何持久化——信息直接被 `microCompactOai` 截断或轮次移除丢弃。

**改动**：在 `maybeCompact` 的 `replaceMessages` 之前调用 `persistExtractedMemories`。

```
修改文件：src/agent/compaction-controller.ts — maybeCompact 方法
位置：this.deps.session.replaceMessages(compacted) 之前

新增逻辑：
  this.persistExtractedMemories(this.deps.getTrajectoryEntries())
```

**门控条件（防止过度写入）**：

| 条件 | 说明 |
|------|------|
| `compacted.length < messages.length` | 只在压缩实际减少了消息数时才持久化（避免无效写入） |
| `compactDecision.tier >= 2` | Tier 1（watch）只标记不压缩，无需持久化 |
| 提取的记忆上限 20 条 | `extractSessionMemories` 已有 `slice(-20)` 上限 |

**成本分析**：
- `extractSessionMemories` 是纯同步正则提取，无 LLM 调用
- `SessionPersist.appendMemory` 是追加 JSON 到 `.memory.json`，I/O < 1ms
- 对 200K 窗口，Tier 2 压缩通常在 60-70% 时触发，会话内约有 30-50 轮对话，可提取约 10-20 条记忆

**平衡考量**：
- ❌ 不对 Tier 1 持久化 — Tier 1 只是标记 watch，不做任何消息修改
- ❌ 不在每次工具调用后持久化 — 频率太高，且信息未经过压缩筛选
- ✅ 只在压缩实际发生时持久化 — 信息正要被丢弃，此时挽救最高效

### P5 — commit fact 自动升级为 project scope

**现状**：`claim-extractor.ts` 的 `commitFact()` 生成 `kind='decision', scope='session'` 的 claim。commit 是架构决策的最佳载体（hash + message + files），但它们随会话结束而消亡。

**改动**：`commitFact()` 的 scope 从 `'session'` 改为 `'project'`。

```
修改文件：src/context/claim-extractor.ts — commitFact 函数
改动：scope: 'session' → scope: 'project'
```

**为什么所有 commit 都升级，而不只升级"大提交"**：

| 考量 | 理由 |
|------|------|
| 提交本身就是门控 | 提交意味着代码通过了 typecheck + 测试 + 交付门禁，已经是高价值信号 |
| 16KB 上限保护 | `memory.jsonl` 有 200 条上限 + 16KB 大小限制，满后按 confidence 排序淘汰最弱条目 |
| 小提交不可怕 | `fix: typo` 这种提交在 memory 中占一行，confidence=0.95，不会挤掉重要决策 |
| 模型可覆盖 | 高置信度的架构决策自然排在小修复前面 |

**实际写入与注入流程（Path C）**：
1. `commitFact()` → scope='project' → `claim-store.propose()`
2. `tool-pipeline.ts` 检测到 `proposal.scope === 'project'` → `appendProjectMemory()`
3. 每次 append 后检查条目数 → 超过 200 条触发 `compactProjectMemory()` 去重 + 裁剪
4. 加载时 `loadProjectMemory()` 再做 Tier 1 过滤：commit fact 是 `decision` 且 `confidence=0.95`，因此进入自动注入；其他低信号条目保留给 recall
5. 渲染预算为 2K chars，按 confidence / createdAt 排序，超出预算时淘汰较弱或较旧条目

**token 膨胀估算**：
- 每条 commit fact 约 80-120 字符（~30 tokens）
- 一个长会话约 10-20 次提交 = 300-600 tokens 新增；但 loader 有 2K chars（约 500 tokens）硬上限
- 预算外的提交 fact 不丢失，仍保留在 `memory.jsonl` 中并可由 recall 搜索（除非 writer compact 触发 200 条/16KB 物理裁剪）

### P6 — extractSessionMemories 高置信度自动升级

**现状**：`extractSessionMemories` 提取 5 种记忆（user_preference, decision, file_observation, failure_pattern, task_state），全部写入 session memory（`.memory.json`），会话结束后不再可用。

**改动**：在 `persistExtractedMemories` 中，对提取的记忆做二次筛选，高价值条目同时写入 project memory。

```
修改文件：src/agent/compaction-controller.ts — persistExtractedMemories 方法

新增逻辑（在 appendMemory 之后）：
  const memories = extractSessionMemories(messages, { recentToolTargets })
  for (const m of memories) {
    if (shouldPromoteToProject(m)) {
      appendProjectMemory(cwd, claimFromMemory(m))
    }
  }
```

**升级门控（`shouldPromoteToProject`）**：

| kind | 升级条件 | 注入结果 | 理由 |
|------|---------|----------|------|
| `decision` | **全部升级**，建议 confidence ≥ 0.9 | Tier 1 自动注入 | 架构决策是 project memory 最核心的内容 |
| `failure_pattern` | 出现 ≥ 2 次去重后仍存在，建议 confidence 0.8 | Tier 2 recall-only（默认不注入） | 重复出现的错误模式值得持久化，但不应每轮污染 prompt |
| `user_preference` | 长度 ≥ 20 字符，且可转写为 `user_constraint` 或 confidence ≥ 0.9 | 只有 `user_constraint + confidence ≥ 0.9` 进入 Tier 1；普通 preference recall-only | 约束影响未来每次决策；偏好可能只是上下文相关 |
| `file_observation` | **不升级** | 不适用 | 文件观察太细碎，数量太多，会快速填满 200 条上限 |
| `task_state` | **不升级** | 不适用 | 任务状态是会话级临时信息 |

**平衡考量**：
- decision 全升级：一个会话中模型通常只做 3-5 个显著决策，不会膨胀
- failure_pattern 要求 ≥ 2 次：一次性 CI 跑挂不值得持久化，但反复出现的错误模式（如"TypeScript strict 不允许隐式 any"）是宝贵知识
- file_observation 不升级：一个会话可读 50+ 文件，全部升级会淹没真正重要的决策
- 200 条上限是最终安全网：即使门控不够严格，物理上限防止无限增长

### P4-P6 整体数据流

```
工具调用 → claim-extractor → scope=project (P5: commit fact)
                           ↓
                    claim-store.propose()
                           ↓
              tool-pipeline 检测 scope=project → appendProjectMemory()
                           ↓
                   .rivet/knowledge/memory.jsonl
                           ↓
              loadProjectMemory → Tier 1 过滤 → frozen volatile block → prefix cache
                           ↓
              loadAllProjectMemoryEntries → recall tool（Tier 1 + Tier 2 全部可检索）

压缩触发（Tier 2+）:
  maybeCompact → persistExtractedMemories (P4: 压缩前保全)
                     ↓
              session memory (.memory.json) — 会话级
                     ↓
              extractSessionMemories → shouldPromoteToProject (P6: 升级门控)
                     ↓
              appendProjectMemory → .rivet/knowledge/memory.jsonl — 项目级
                     ↓
              Tier 1: decision/project_rule/user_constraint + confidence ≥ 0.9 自动注入
              Tier 2: 其他条目 recall-only
```

### 成本汇总

| 改动 | 新增 token/turn | 新增 I/O | 新增 LLM 调用 |
|------|----------------|----------|---------------|
| P4 | 0（写入不必然增加 prompt；仅被升级为 Tier 1 的条目影响 frozen block） | +1 次 JSON append | 0 |
| P5 | +0-30 tokens/commit，受 2K chars Tier 1 预算约束（prefix cache 覆盖后为 0） | +1 次 JSONL append/commit | 0 |
| P6 | decision/user_constraint 可能进入 Tier 1；failure_pattern 默认 recall-only | +1-3 次 JSONL append/session | 0 |

**结论**：三项改动不增加每轮动态 token；只有 Tier 1 变化会刷新 frozen block 的 prefix cache，且自动注入被 2K chars 硬上限约束。

## 9. 已知待办（下个会话）

| 优先级 | 项目 | 说明 |
|--------|------|------|
| **P0** | 补测试 | `project-memory-writer.test.ts` + `project-memory-loader.test.ts` |
| **P1** | P4: maybeCompact 持久化 | `compaction-controller.ts` 在 replaceMessages 前调 `persistExtractedMemories` |
| **P1** | P5: commit fact 升级 | `claim-extractor.ts` commitFact scope → 'project' |
| **P1** | P6: session memory 升级门控 | `compaction-controller.ts` 在 persistExtractedMemories 中加 shouldPromoteToProject |
| **P1** | 并发安全验证 | 实测两个进程并发 append + compact 的行为 |
| **P2** | .gitignore | 将 `.rivet/knowledge/memory.jsonl` 加入默认 gitignore |
| **P2** | 用户级全局 memory | `~/.config/rivet/knowledge/` 支持 |
| **P3** | Memory 膨胀监控 | 在 TUI 中显示当前 memory 条目数 + token 估算 |
| **P3** | 记忆去噪 | 定期清理过时/低置信度条目（类似 gbrain 的 decay 机制） |

## 10. 不做什么

1. **不做向量检索** — 当前子串匹配够用；Tier 1 自动注入只有 2K chars，Tier 2 由 recall 处理，不需要语义搜索
2. **不做 LLM 自动提取** — 保持现有 extractClaimsFromToolResult 的规则提取
3. **不做合成层** — 不需要 gbrain 的 think 管线，Tier 1 直接注入 XML 块，Tier 2 按需召回
4. **不改 Dream** — Dream 保持独立，继续做它的 curated 归档
5. **不做知识图谱** — 当前项目不需要实体关系推理

## 11. gbrain 参考架构摘要

> gbrain (github.com/garrytan/gbrain) 是一个 645 文件的个人知识库系统，使用 PGLite 数据库。
> 以下是我们参考过的核心机制，以及为什么 Rivet 选择了不同的路径。

| gbrain 机制 | gbrain 实现 | Rivet 选择 | 理由 |
|-------------|------------|-----------|------|
| 事实提取 | LLM 管线（Haiku 抽取 → 矛盾分类 → 衰减评分） | 规则提取（claim-extractor.ts） | 避免 LLM 调用开销；编码 Agent 的 claim 种类有限且可枚举 |
| 存储后端 | PGLite（嵌入式 Postgres + pgvector） | JSONL 文件 | 零依赖；200 条以内不需要索引 |
| 检索方式 | 混合检索（vector + BM25 + RRF 融合排序） | Path C：Tier 1 小预算自动注入 + Tier 2 recall-only | 高价值规则/决策无需 embedding；低信号条目不污染 prompt |
| 合成层 | `gbrain think`（检索 → LLM 合成 → 引用 → 空洞分析） | Tier 1 直接注入 XML；Tier 2 recall 返回原始条目 | 高价值条目结构化、数量少；低信号条目无需常驻合成 |
| Dream 循环 | 6 阶段（lint → extract → embed → facts → weight → consolidate） | 1 步（compact：去重 + 按置信度裁剪） | 简单场景不需要多阶段管线 |
| 知识图谱 | 实体关系边（attended, works_at, invested_in…） | 无 | 编码 Agent 不需要人物/事件关系推理 |
| 衰减机制 | 置信度随时间指数衰减 + 半衰期配置 | 无（按 confidence 排序，未来可加） | P3 级需求，当前 memory 条目少不需要 |

**关键差异**：gbrain 处理的是非结构化个人知识（笔记、对话、文章），需要 LLM 提取 + 向量检索。Rivet 处理的是结构化编码知识（架构决策、用户约束、项目规则），可以规则提取，并用 Path C 将高价值 Tier 1 小预算注入、其余 Tier 2 留给 recall。
