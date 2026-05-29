# 上下文压缩去重键精细化 — 范围感知去重修复

> **面向 AI 代理：** 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复三层上下文压缩（AgentDiet / Staleness Detection / Semantic Prune）用粗糙键（仅 `file_path` 或仅 `pattern`）做去重导致的信息丢失 bug。核心症状：同一文件用不同 `offset`/`limit` 分段读取时，前一段被错误标记为 `[diet:redundant]` 或 `[superseded: ...]`，agent 丢失关键区域可见性，在"半盲"状态下编辑代码。

**架构：** 三处精准修复，均在同一模块 `src/compact/` 下，改动范围小且独立。

**技术栈：** TypeScript strict / node:test + assert/strict / OAI message format

---

## 1. 问题诊断

### 1.1 症状

用户在长 session 中反复读取同一文件的不同区域时，压缩层返回：

```
[superseded: read_file app.tsx — re-read at later step]
[outdated grep — re-read at later step]
[diet:redundant] re-read later
```

agent 看不到之前读取的文件区域内容，在信息不完整的情况下做编辑。

### 1.2 根因

三个压缩层都用**过于粗糙的键**判断冗余，忽略了 read_file 的 `offset`/`limit` 和 grep 的 `path`/`glob`：

| 压缩层 | 文件 | 函数 | 当前键 | 遗漏参数 |
|--------|------|------|--------|----------|
| AgentDiet | `agent-diet.ts` | `extractPath()` | `file_path` | `offset`, `limit` |
| Staleness Detection | `staleness-detect.ts` | `extractFilePath()` | `file_path` | `offset`, `limit` |
| Semantic Prune | `semantic-prune.ts` | grep dedup map | `pattern` | `path`, `glob` |

### 1.3 典型误伤场景

```
Step 1: read_file(file_path="app.tsx", offset=1, limit=200)  → 返回 L1-L200
Step 2: read_file(file_path="app.tsx", offset=400, limit=100) → 返回 L400-L500
         ↑ diet/staleness 把 Step 1 标记为 redundant/superseded
         ↑ 但两次读取完全不重叠！L1-L200 信息永久丢失
```

对于 grep：
```
Step 1: grep(pattern="handleSubmit", path="src/tools/")  → 搜索 tools 目录
Step 2: grep(pattern="handleSubmit", path="src/agent/")  → 搜索 agent 目录
         ↑ semantic-prune 把 Step 1 标记为 outdated grep
         ↑ 但两次搜索不同目录！结果完全不同
```

---

## 2. Scope Check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/compact/agent-diet.ts` | ✅ 是 | extractPath 返回范围感知复合键 |
| `src/compact/staleness-detect.ts` | ✅ 是 | 文件去重键加入 offset/limit |
| `src/compact/semantic-prune.ts` | ✅ 是 | grep 去重键加入 path/glob |
| `src/compact/__tests__/agent-diet.test.ts` | ✅ 是 | 新增 offset/limit 去重测试 |
| `src/compact/__tests__/staleness-detect.test.ts` | ✅ 是 | 新增范围感知测试 |
| `src/compact/__tests__/semantic-prune.test.ts` | ✅ 是 | 新增 grep 多路径测试 |
| `src/agent/` | ❌ 否 | 调用方无需改动，接口不变 |
| `src/tools/` | ❌ 否 | 工具实现不改动 |

---

## 3. 修复策略

### 3.1 核心原则：范围包含语义

对于 `read_file`，仅当后续读取的**范围完全包含**前一次读取的范围时，前一次才可安全去重：

- 全量读取（无 offset/limit）→ 包含任何带范围的读取 ✅
- `offset=1, limit=500` → 包含 `offset=100, limit=50` ✅
- `offset=1, limit=200` → **不**包含 `offset=400, limit=100` ❌
- `offset=1, limit=200` → **不**包含 全量读取 ❌

### 3.2 复合键设计

**read_file 键**：`file_path|offset|limit`（`-1` 表示未指定/无限制）

去重条件：后续读取的键在范围上完全包含旧键。

**grep 键**：`pattern|path|glob`（空字符串表示未指定）

去重条件：后续搜索的 pattern+path+glob 完全一致。

---

## 4. File Structure

### 4.1 修改文件

| 文件 | 改动 |
|------|------|
| `src/compact/agent-diet.ts` | `extractPath` → 返回 `file_path\|offset\|limit` 复合键；Pass 1 索引改为按复合键分组 |
| `src/compact/staleness-detect.ts` | `extractFilePath` → 对 read_file 返回复合键；键比较逻辑适配 |
| `src/compact/semantic-prune.ts` | grep dedup map 键从 `pattern` 改为 `pattern\|path\|glob` |

### 4.2 测试文件

| 文件 | 改动 |
|------|------|
| `src/compact/__tests__/agent-diet.test.ts` | 新增：不同 offset 不应去重；包含范围应去重 |
| `src/compact/__tests__/staleness-detect.test.ts` | 新增：不同 offset 不应 supersede |
| `src/compact/__tests__/semantic-prune.test.ts` | 新增：不同 path 的 grep 不应去重 |

---

## 5. Tasks

### 任务 1：AgentDiet — read_file 范围感知去重

**文件：**
- 修改：`src/compact/agent-diet.ts`
- 修改：`src/compact/__tests__/agent-diet.test.ts`

- [x] **步骤 1：编写失败的测试（TDD）**

  ```typescript
  // 测试 1：不同 offset 读取同一文件 → 不应去重
  it('does NOT remove read_file with different offset (non-overlapping ranges)', () => {
    // read_file("app.tsx", offset=1, limit=100)
    // read_file("app.tsx", offset=200, limit=100)
    // → 两个结果都应保留，因为范围不重叠
  })

  // 测试 2：全量读取包含带 offset 的读取 → 应去重
  it('removes read_file when later full read contains the range', () => {
    // read_file("app.tsx", offset=100, limit=50)
    // read_file("app.tsx")  ← 全量包含前者
    // → 前者标记为 redundant
  })

  // 测试 3：大范围包含小范围 → 应去重
  it('removes read_file when later read has larger containing range', () => {
    // read_file("app.tsx", offset=100, limit=20)
    // read_file("app.tsx", offset=50, limit=200)  ← 包含前者
    // → 前者标记为 redundant
  })
  ```

- [x] **步骤 2：修改 `extractPath` 返回复合键**

  将返回值从 `string | undefined` 扩展：对 read_file 拼接 `file_path|offset|limit`（offset/limit 未指定时用 `-1`）。
  
  注意：需要同时修改调用方 `fileReads` Map 的 key 比较逻辑，使得范围包含判断生效。

- [x] **步骤 3：修改 Pass 2 去重判定**

  在 `reads.some(r => r > idx)` 基础上增加范围包含检查：
  - 解析当前键和后续读取键
  - 仅当后续读取范围包含当前范围时标记 redundant

- [x] **步骤 4：运行测试验证**

  ```bash
  npm exec -- tsx --test src/compact/__tests__/agent-diet.test.ts
  ```

### 任务 2：Staleness Detection — read_file 范围感知

**文件：**
- 修改：`src/compact/staleness-detect.ts`
- 修改：`src/compact/__tests__/staleness-detect.test.ts`

- [x] **步骤 1：编写失败的测试**

  ```typescript
  it('does NOT supersede read_file with different offset ranges', () => {
    // read_file("loop.ts", offset=1, limit=100)
    // read_file("loop.ts", offset=500, limit=100)
    // → 前者不应被标记为 superseded
  })

  it('supersedes read_file when later full read covers it', () => {
    // read_file("loop.ts", offset=100, limit=50)
    // read_file("loop.ts")  ← full read
    // → 前者被标记为 superseded
  })
  ```

- [x] **步骤 2：修改 `extractFilePath` 返回复合键**

  对 read_file：返回 `file_path|offset|limit`。
  对 grep：返回 `file_path|path`（grep 用 path 参数，不是 file_path）。

- [x] **步骤 3：修改 `fileLatestIdx` Map 的键比较**

  使 Map 能按复合键查找：先精确匹配复合键，再 fallback 到范围包含逻辑。

- [x] **步骤 4：运行测试验证**

  ```bash
  npm exec -- tsx --test src/compact/__tests__/staleness-detect.test.ts
  ```

### 任务 3：Semantic Prune — grep 路径感知去重

**文件：**
- 修改：`src/compact/semantic-prune.ts`
- 修改：`src/compact/__tests__/semantic-prune.test.ts`

- [x] **步骤 1：编写失败的测试**

  ```typescript
  it('does NOT dedup grep with same pattern but different path', () => {
    // grep(pattern="handleSubmit", path="src/tools/")
    // grep(pattern="handleSubmit", path="src/agent/")
    // → 两个结果都应保留
  })

  it('dedups grep with same pattern AND same path', () => {
    // grep(pattern="handleSubmit", path="src/tools/")
    // grep(pattern="handleSubmit", path="src/tools/")
    // → 前者标记为 outdated
  })
  ```

- [x] **步骤 2：修改 grep dedup map 键**

  将 `grepPatterns` Map 的键从 `pattern` 改为 `pattern|path|glob`：
  
  ```typescript
  const key = [args.pattern, args.path ?? '', args.glob ?? ''].join('|')
  ```

- [x] **步骤 3：同步修改 outdated 标记的判断逻辑**

  用同样的复合键做比较。

- [x] **步骤 4：运行测试验证**

  ```bash
  npm exec -- tsx --test src/compact/__tests__/semantic-prune.test.ts
  ```

### 任务 4：集成验证

- [x] **步骤 1：运行全部 compact 测试**

  ```bash
  npm exec -- tsx --test src/compact/__tests__/*.test.ts
  ```

- [x] **步骤 2：类型检查**

  ```bash
  npx tsc --noEmit
  ```

- [x] **步骤 3：运行全量测试（确保无回归）**

  ```bash
  npm exec -- tsx --test src/**/__tests__/*.test.ts
  ```

---

## 6. 设计决策与权衡

### 为什么不直接加 offset/limit 到键里做精确匹配？

精确匹配（`file_path|offset|limit` 完全相同才去重）是最安全的方案，但压缩率太低——agent 经常先 `read_file("foo.ts")` 了解全貌，再 `read_file("foo.ts", offset=100, limit=50)` 细看某个函数。这种情况下全量读取确实包含了后续范围读取的内容，精确匹配无法去重。

范围包含语义在安全性和压缩率之间取得平衡：只有数学上可证明后续读取包含了前一次读取的全部信息时才去重。

### 为什么不改接口？

所有三个压缩函数的公共接口（`DietResult`、`StalenessResult`、`SemanticPruneResult`）和调用方（`p3-integration.ts`、`prompt/engine.ts`、`loop.ts`）保持不变。改动完全内聚在 compact 模块内部。
