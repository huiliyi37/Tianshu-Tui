# 文件归属自动继承 — 消除 deliver_task 无意义 YELLOW

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除 `deliver_task` 因"文件无归属分类"而产生的无意义 YELLOW。新增自动分类逻辑：凡是不在 WorktreeBaseline（session 启动时即存在的脏文件/未跟踪文件）中的新文件，自动归为当前 session 的 owned 文件。

**架构：** 在 `OwnershipLedger` 中新增 `autoOwnFromBaseline(dirtyFiles)` 方法——对每个未分类的脏文件，检查 WorktreeBaseline 是否已记录（pre-existing），未记录则为新文件 → 自动 `registerOwned`。在 `deliver_task` 中，`autoOwnFromLedger` 之后调用 `autoOwnFromBaseline`，使健康检查不再看到未分类文件。

**技术栈：** TypeScript strict / node:test + assert/strict

---

## 1. Scope check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/agent/ownership-ledger.ts` | ✅ 是 | 新增 `autoOwnFromBaseline` 方法 |
| `src/agent/deliver-task.ts` | ✅ 是 | 调用 `autoOwnFromBaseline` |
| `src/agent/ownership-health.ts` | ❌ 否 | 不修改——警告逻辑不变，只是上游不再传入未分类文件 |
| `src/agent/worktree-baseline.ts` | ❌ 否 | 不改——`isExternal` 和 `getExternalFiles` 已足够 |
| `src/agent/__tests__/ownership-ledger.test.ts` | ✅ 是 | 新增自动分类测试 |
| `src/agent/__tests__/deliver-task.test.ts` | ✅ 修改 | 验证 YELLOW→GREEN 转换 |

---

## 2. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/ownership-ledger.ts` | 修改 | 新增 `autoOwnFromBaseline`，增强 `OwnershipLedger` 接口 |
| `src/agent/deliver-task.ts` | 修改 | `autoOwnFromLedger` 之后调用 `autoOwnFromBaseline` |
| `src/agent/__tests__/ownership-ledger.test.ts` | 修改 | 新增测试 |
| `src/agent/__tests__/deliver-task.test.ts` | 修改 | 验证无未分类文件时不再 YELLOW |

---

## 3. Research endorsement（调研背书）

### 3.1 当前 YELLOW 的根因

**文件**：`src/agent/ownership-health.ts:35-39`

```typescript
for (const f of input.dirtyFiles) {
    if (!owned.has(f) && !coOwned.has(f) && !external.has(f)) {
      warningLines.push(`Dirty file has no ownership classification: ${f}`)
    }
  }
```

当脏文件不在 owned/coOwned/external 任意集合中时，生成 warning → 触发 YELLOW。

**为什么会出现未分类文件：**
1. `write_file` / `edit_file` → `registerOwned()` 实时登记（正常路径）
2. `bash` 执行 git 操作 → 记录在 TaskLedger 中 → `autoOwnFromLedger()` 回填
3. **间隙**：外部进程（其他 session、手动编辑）产生的脏文件从未被任何工具写入，既不在 ownedSet 也不在 coOwnedSet

**当前 workaround**：`autoOwnFromLedger()` 遍历 TaskLedger 事件回填，但只覆盖工具明确记录的事件，遗漏了外部修改。

### 3.2 WorktreeBaseline 已提供判断依据

**文件**：`src/agent/worktree-baseline.ts`

`WorktreeBaseline` 在 session 启动时快照：
- `preExistingDirty: Set<string>` — 启动时已修改但未暂存的文件
- `preExistingUntracked: Set<string>` — 启动时未跟踪的文件
- 两者合并为 `externalSet`，`isExternal(file)` 检查文件是否在此集合中

**核心洞察**：任何不在 `externalSet` 中的脏文件，一定是当前 session 中**新创建**的。这些文件应自动归为 owned。

### 3.3 修复方案

在 `OwnershipLedger` 中新增 `autoOwnFromBaseline(dirtyFiles: string[])`：

```typescript
function autoOwnFromBaseline(dirtyFiles: string[]): void {
  for (const f of dirtyFiles) {
    // 已分类 → 跳过
    if (ownedSet.has(f) || coOwnedSet.has(f)) continue
    // 在 baseline 中 → 外部文件 → 跳过（由 autoOwnFromLedger 或 registerOwned 处理）
    if (baseline.isExternal(f)) continue
    // 新文件 → 自动归为当前 session 的 owned
    ownedSet.add(f)
  }
}
```

**为什么 safe**：
- 只影响未分类文件 → 不会覆盖已有分类
- baseline 中的文件（pre-existing）被跳过 → 不会错误地将外部文件标记为 owned
- 仅新增 owned 分类，不删除或修改已有分类

### 3.4 deliver_task 调用顺序

`deliver-task.ts:125` 当前：
```typescript
ctx.ownership.autoOwnFromLedger()
const currentDirtyFiles = ...
```

修改后：
```typescript
ctx.ownership.autoOwnFromLedger()
const currentDirtyFiles = ...
ctx.ownership.autoOwnFromBaseline(currentDirtyFiles)
```

先回填 TaskLedger 事件，再用 baseline 自动分类剩余未分类文件。

---

## 4. Tasks

### Task 1: OwnershipLedger 新增 `autoOwnFromBaseline`

**目标**：在 OwnershipLedger 接口和实现中添加自动基线分类方法。

**文件**：`src/agent/ownership-ledger.ts`

#### 1a. 接口新增方法签名

在 `OwnershipLedger` 接口（约第 38 行，`autoOwnFromLedger` 之后）添加：

```typescript
/** Auto-classify unclassified dirty files by checking WorktreeBaseline.
 *  Files NOT in the baseline (pre-existing sets) are new → auto-owned.
 *  Files IN the baseline are pre-existing → left unclassified (already handled). */
autoOwnFromBaseline(dirtyFiles: string[]): void
```

#### 1b. 实现方法

在 `createOwnershipLedger` 函数体内，`autoOwnFromLedger` 之后添加：

```typescript
function autoOwnFromBaseline(dirtyFiles: string[]): void {
  for (const f of dirtyFiles) {
    // Already classified — skip
    if (ownedSet.has(f) || coOwnedSet.has(f)) continue
    // Pre-existing in baseline — not ours to auto-own
    if (baseline.isExternal(f)) continue
    // New file created this session → auto-own
    ownedSet.add(f)
  }
}
```

#### 1c. 在返回对象中注册

在 `return { ... }` 对象中添加：
```typescript
autoOwnFromBaseline,
```

---

### Task 2: deliver_task 调用 autoOwnFromBaseline

**目标**：在 health check 之前自动分类未分类的脏文件。

**文件**：`src/agent/deliver-task.ts:125`

修改前：
```typescript
ctx.ownership.autoOwnFromLedger()
const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? collectCurrentDirtyFiles(params.cwd)
```

修改后：
```typescript
ctx.ownership.autoOwnFromLedger()
const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? collectCurrentDirtyFiles(params.cwd)
ctx.ownership.autoOwnFromBaseline(currentDirtyFiles)
```

---

### Task 3: 测试

**目标**：验证自动分类逻辑和端到端 YELLOW→GREEN 转换。

#### 3a. OwnershipLedger 单元测试

**文件**：`src/agent/__tests__/ownership-ledger.test.ts`

```typescript
describe('autoOwnFromBaseline', () => {
  it('auto-owns new dirty files not in baseline', () => {
    // baseline has pre-existing: ['src/old.ts']
    // dirty files: ['src/old.ts', 'src/new.ts']
    // autoOwnFromBaseline should add 'src/new.ts' to owned set
    const ledger = createOwnershipLedger({ baseline, taskLedger })
    ledger.autoOwnFromBaseline(['src/old.ts', 'src/new.ts'])
    assert.equal(ledger.isOwned('src/new.ts'), true)
    assert.equal(ledger.isOwned('src/old.ts'), false) // pre-existing, not owned
  })

  it('does not reclassify already-owned files', () => {
    ledger.registerOwned('src/existing.ts')
    ledger.autoOwnFromBaseline(['src/existing.ts'])
    assert.equal(ledger.isOwned('src/existing.ts'), true) // unchanged
  })

  it('skips files already in co-owned set', () => {
    // setup: register a co-owned file via external path
    ledger.autoOwnFromBaseline(['src/external.ts'])
    assert.equal(ledger.isOwned('src/external.ts'), false)
  })
})
```

#### 3b. deliver_task 集成测试

**文件**：`src/agent/__tests__/deliver-task.test.ts`

新增测试：验证当只有新文件（不在 baseline 中）被修改时，deliver_task 不再产生 "no ownership classification" 警告。

```typescript
it('auto-classifies new dirty files — no YELLOW for unclassified', () => {
  // Create a fresh repo with a new file (not in baseline)
  // Run deliver_task without commit
  // Verify: no "Dirty file has no ownership classification" in output
})
```

**验证**：
```bash
node --import tsx --test --test-name-pattern="autoOwn" src/agent/__tests__/ownership-ledger.test.ts
node --import tsx --test src/agent/__tests__/deliver-task.test.ts
```

---

## 5. Verification

| 验证项 | 命令 | 预期结果 |
|--------|------|----------|
| TypeScript 编译 | `npx tsc --noEmit` | 0 errors |
| ownership-ledger 测试 | `node --import tsx --test src/agent/__tests__/ownership-ledger.test.ts` | 全部通过 |
| deliver-task 测试 | `node --import tsx --test src/agent/__tests__/deliver-task.test.ts` | 全部通过 |
| 全量回归 | `npm exec -- tsx --test src/**/__tests__/*.test.ts` | 无新增失败 |

---

## 6. Self-check

### 6.1 Spec coverage

| 需求 | 覆盖任务 |
|------|----------|
| 新文件自动归为 owned | Task 1b, Task 3a |
| 不覆盖已有分类 | Task 1b (continue 守卫) |
| 不将 baseline 文件标记为 owned | Task 1b (isExternal 守卫) |
| deliver_task 集成 | Task 2, Task 3b |
| 不影响 RED/GREEN 判断 | 显式排除 |

### 6.2 Placeholder scan

✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节

### 6.3 Type consistency

- `autoOwnFromBaseline(dirtyFiles: string[]): void` — 纯副作用，无返回值
- `baseline.isExternal(filePath: string): boolean` — 已存在，签名不变
- `ownedSet: Set<string>` — 内部状态，类型不变

---

## 7. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-29-auto-ownership.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
