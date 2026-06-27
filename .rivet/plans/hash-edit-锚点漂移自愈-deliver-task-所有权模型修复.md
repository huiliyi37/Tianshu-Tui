> **Status: COMPLETED** — 2026-06-19

# hash_edit 锚点漂移自愈 + deliver_task 所有权模型修复

# hash_edit 锚点漂移自愈 + deliver_task 所有权模型修复

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法。

**目标：** 消除 `hash_edit` 连续编辑时的锚点漂移失败（需反复重读文件），修复 `deliver_task` 中 `adoptFiles` 对 co-owned 文件的静默跳过 bug，使交付门禁一轮通过。

**架构：** 两处独立改动。—— `hash_edit` 增加 stale recovery 模式：锚点过期时用内容子串搜索自动定位并重试；—— `ownership-ledger` 修复 `adoptFiles` 守卫条件，允许 co-owned → adopted 迁移，并同步清理 `isOwned` / `getOwnedFiles` 的一致性。

**技术栈：** TypeScript strict, node:test, node:assert/strict

---

## 1. Scope Check

两个改动操作完全独立的子系统：

- **A 线 — hash_edit 自愈**：仅涉及 `src/tools/hash-edit.ts` + 测试
- **B 线 — 所有权模型修复**：仅涉及 `src/agent/ownership-ledger.ts` + `src/agent/deliver-task.ts` 验证层 + 测试

无跨系统依赖，可分两波独立交付。

---

## 2. 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/tools/hash-edit.ts` | hash_edit 核心实现 | 修改：增加 stale recovery |
| `src/tools/__tests__/hash-edit.test.ts` | hash_edit 测试 | 修改：增加 recovery 测试 |
| `src/agent/ownership-ledger.ts` | 所有权登记 | 修改：修复 adoptFiles 守卫 |
| `src/agent/__tests__/ownership-ledger.test.ts` | 所有权测试 | 修改：增加 co-owned 迁移测试 |
| `src/agent/deliver-task.ts` | 交付门禁 | 验证：确认消息层一致（只读不改） |

---

## 3. 调研背书

### 3.1 hash_edit 锚点漂移

**调用方：**
- `grep` → 输出 hash_edit anchor hints（`src/tools/grep.ts:178-216`）
- `edit_file` → 旧字符串匹配失败时回退建议 hash_edit（`src/tools/edit.ts:257`）
- Agent 主控 → 通过 ToolRegistry 调用（`src/tools/registry.ts:44`）

**存在原因：** hash_edit 是安全编辑的核心机制。相比 `edit_file` 的 `old_string` 匹配，hash_edit 的锚点机制（行号+内容哈希）消除了空白歧义和"文件中唯一"要求。但代价是锚点必须在文件读取时计算，文件变更后失效。

**当前行为：**
1. 模型通过 `grep` 或 `read_file` 获取锚点
2. 第一次 `hash_edit` 成功 → 文件内容变更
3. 第二次 `hash_edit` 用同一批锚点 → 锚点过期 → 返回错误
4. 模型必须重新 `read_file` → 重新 `grep` → 重新 `hash_edit`

**失效模式（本会话实测）：**
- 同一文件上连续 3 次 hash_edit → 后 2 次每次都需重读
- `grep` 返回 10 个锚点 → 修第 1 个 → 其余 9 个全部过期
- `position-only` 模式检测 mtime 变化 → 正确拒绝，但不提供恢复路径

**边界风险：**
- 自动恢复不能引入静默错位（修改到错误的行）
- 同名内容多行时不能匹配到错误的行
- 大文件中搜索性能

**修复策略（stale recovery）：**
当锚点过期时，`hash_edit` 不直接报错，而是：
1. 对每个过期锚点，提取其**原始内容**（从 stale diagnostic 中已有 `actualLine`）
2. 在**锚点预期行号的 ±N 行范围内**搜索匹配该哈希的行
3. 如果所有过期锚点都能在新位置复现，用新锚点重试
4. 如果任一锚点找不到，才报错（保留原 fail-safe 行为）

搜索窗口：`anchor.line ± max(50, fileLines * 0.1)` → 覆盖合理的行号漂移，不扫描全文件。

### 3.2 deliver_task 所有权模型

**调用方：**
- `deliver_task` 工具 → `ctx.ownership.adoptFiles(adoptFiles) (src/agent/deliver-task.ts:431)`
- `delivery_gate_v2` → `getExternalFiles()` / `getOwnedFiles()` 用于门禁判定

**存在原因：** B1 所有权模型追踪多会话共享工作区中的文件归属。三类文件：
- `owned`：当前任务创建/修改的非 pre-existing 文件
- `co-owned`：pre-existing 文件被当前任务修改（共享所有权）
- `external`：完全由其他会话创建的文件

`adoptFiles` 的初衷是跨会话接管：A 会话崩溃后，B 会话 force-claim A 的文件。

**当前行为（Bug）：**
```ts
// ownership-ledger.ts:150-158
function adoptFiles(files: string[]): string[] {
    const adopted: string[] = []
    for (const f of files) {
      if (!ownedSet.has(f) && !coOwnedSet.has(f) && !adoptedSet.has(f)) {
        //      ^^^^^^^^^^^^^^^^^^^^ BUG: skips co-owned files
        adoptedSet.add(f)
        adopted.push(f)
      }
    }
    return adopted.sort()
  }
```

`!coOwnedSet.has(f)` 守卫导致 co-owned 文件被静默跳过。但 `deliver-task.ts:422` 明确声明：
> Co-owned files can be adopted when the other session is done/crashed.

**后果：**
1. 用户尝试 adopt co-owned 文件 → 验证层通过（deliver-task.ts:426 `adoptableSet` 包含 coOwnedSet）
2. 实际执行 `adoptFiles()` → co-owned 文件被跳过，返回空列表
3. 用户看到 "Adopted 0 co-owned file(s)" 或根本没有 adoption 消息
4. 后续 `getOwnedFiles()` 不包含该文件 → commit 被拒绝

**修复策略：**
```ts
function adoptFiles(files: string[]): string[] {
    const adopted: string[] = []
    for (const f of files) {
      // 允许已 owned 的文件（幂等）
      if (ownedSet.has(f)) continue
      // 允许已 adopted 的文件（幂等）
      if (adoptedSet.has(f)) continue
      // co-owned → adopted：从共享所有权迁移为独占所有权
      if (coOwnedSet.has(f)) {
        coOwnedSet.delete(f)
      }
      adoptedSet.add(f)
      adopted.push(f)
    }
    return adopted.sort()
  }
```

**一致性检查：**
- `isOwned()` → 检查 `adoptedSet.has(f)` → adopted 文件已是 owned ✅
- `getOwnedFiles()` → 返回 `[...ownedSet, ...adoptedSet]` → adopted 文件包含在内 ✅
- `getCoOwnedFiles()` → 返回 `[...coOwnedSet]` → 已被 adopted 的文件不再出现 ✅（因为已从 coOwnedSet 删除）
- `getExternalFiles()` → 检查 `!ownedSet.has(f) && !coOwnedSet.has(f) && !adoptedSet.has(f)` → adopted 文件不出现 ✅

---

## 4. 任务

### Wave 1: hash_edit stale recovery（3 tasks）

#### Task 1.1: 测试 — stale recovery 搜索与定位
- [ ] **创建/修改**：`src/tools/__tests__/hash-edit.test.ts`
  - 新增测试：`'stale anchors auto-recover when content shifted by prior edit'`
    - 设置：3 行文件 `a\nb\nc\n`，计算 L1/L3 的哈希锚点
    - 模拟前序编辑：在 L1 前插入 2 行 → 原 L1 变 L3，原 L3 变 L5
    - 调用 hash_edit 时传入原锚点 `L1:<hash_a>`, `L3:<hash_c>`
    - 验证：自动搜索找到 `L3:<hash_a>`, `L5:<hash_c>` → 编辑成功
  - 新增测试：`'stale recovery fails when anchor content not found in search window'`
    - 锚点内容完全不在文件中 → 返回错误（不静默）
  - 新增测试：`'stale recovery handles multi-anchor with partial match'`
    - 3 个锚点中 2 个找到、1 个找不到 → 返回错误指明哪个找不到
  - 新增测试：`'stale recovery on position-only anchors falls through to error'`
    - position-only 锚点（无哈希）过期 → 不尝试恢复，直接报错（无法做内容匹配）
  - 运行测试：`npm exec -- tsx --test src/tools/__tests__/hash-edit.test.ts` → RED（功能未实现）
  - Commit: `test(hash-edit): add stale anchor auto-recovery tests`

#### Task 1.2: 实现 — stale recovery 引擎
- [ ] **修改**：`src/tools/hash-edit.ts:193-230`（staleness 检测与编辑执行之间的区域）
  - 在 `formatStaleDiagnostic` 调用之前，插入 recovery 逻辑：
    ```ts
    // ── Stale recovery ──────────────────────────────────
    // 当全哈希锚点过期时，在锚点预期行号附近搜索匹配哈希的行。
    // 如果所有过期锚点都能找到，自动更新锚点并重试。
    const SEARCH_WINDOW = 50  // ±N 行
    if (mismatches.length > 0 && mismatches.every(m => m.anchor.hash !== null)) {
      const recoveredAnchors: Anchor[] = [...anchors]
      let allRecovered = true
      for (const m of mismatches) {
        const targetHash = m.anchor.hash!
        const searchStart = Math.max(1, m.anchor.line - SEARCH_WINDOW)
        const searchEnd = Math.min(lines.length, m.anchor.line + SEARCH_WINDOW)
        let found = false
        for (let i = searchStart; i <= searchEnd; i++) {
          if (hashLine(lines[i - 1]!) === targetHash) {
            // 更新锚点到新位置
            const idx = recoveredAnchors.findIndex(a => a.line === m.anchor.line && a.hash === m.anchor.hash)
            if (idx >= 0) recoveredAnchors[idx] = { line: i, hash: targetHash }
            found = true
            break
          }
        }
        if (!found) { allRecovered = false; break }
      }
      if (allRecovered && recoveredAnchors.every(a => a.line > 0)) {
        // 用恢复的锚点重试编辑（递归一次，避免嵌套）
        // 直接应用编辑，跳过 staleness 检查（已验证内容匹配）
        const firstLine = recoveredAnchors[0]!.line
        const lastLine = recoveredAnchors[recoveredAnchors.length - 1]!.line
        const before = lines.slice(0, firstLine - 1)
        const after = lines.slice(lastLine)
        const newLines = newString === '' ? [] : newString.split('\n')
        const newContent = [...before, ...newLines, ...after].join('\n')
        const relPath = relative(params.cwd, filePath)
        trackFileChange(params.cwd, { filePath: relPath, action: 'edit', toolCallId: params.toolUseId ?? 'hash_edit' })
        await writeFileAtomicAsync(filePath, newContent)
        refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
        const warn = syntaxCheck(filePath, newContent)
        return { content: `hash_edit (auto-recovered ${mismatches.length} stale anchors) applied to ${filePath}: replaced L${firstLine}-L${lastLine} (${lastLine - firstLine + 1} lines) with ${newLines.length} lines` + (warn ? '\n\n' + warn : '') }
      }
    }
    ```
  - 运行测试：`npm exec -- tsx --test src/tools/__tests__/hash-edit.test.ts` → GREEN（4 新测试 + 已有测试全绿）
  - 运行 typecheck：`npx tsc --noEmit` → 0 errors
  - Commit: `feat(hash-edit): auto-recover stale anchors via content-hash search`

#### Task 1.3: 验证 — grep→hash_edit 全链路
- [ ] **验证**：运行全部 hash_edit 测试 + grep 测试
  - `npm exec -- tsx --test src/tools/__tests__/hash-edit.test.ts`
  - `npm exec -- tsx --test src/tools/__tests__/grep.test.ts`
  - 预期：全绿
- [ ] **验证**：确认已有测试没有被削弱
  - `'rejects stale anchors'` 测试仍通过（锚点哈希故意设为 deadbeef → 搜索窗口找不到 → 正确拒绝）
  - `'rejects position-only anchor when line exceeds file'` 测试仍通过
- [ ] Commit: `test(hash-edit): verify stale recovery doesn't weaken existing guard tests`

### Wave 2: ownership 模型修复（2 tasks）

#### Task 2.1: 测试 — co-owned 迁移
- [ ] **创建/修改**：`src/agent/__tests__/ownership-ledger.test.ts`（若不存在则创建）
  - 新增测试：`'adoptFiles migrates co-owned files to adopted set'`
    - 创建 OwnershipLedger + mock baseline（标记文件为 pre-existing → `isExternal` 返回 true）
    - `registerOwned('shared.ts')` → 进入 coOwnedSet
    - `adoptFiles(['shared.ts'])` → 应返回 `['shared.ts']`
    - 验证 `isOwned('shared.ts')` → true
    - 验证 `getOwnedFiles()` 包含 `shared.ts`
    - 验证 `getCoOwnedFiles()` 不包含 `shared.ts`
  - 新增测试：`'adoptFiles is idempotent on already-adopted files'`
    - 连续两次 `adoptFiles(['x.ts'])` → 第一次返回 `['x.ts']`，第二次返回 `[]`
  - 新增测试：`'adoptFiles does not duplicate owned files'`
    - 文件已在 ownedSet → `adoptFiles` 返回 `[]`
  - 运行测试：`npm exec -- tsx --test src/agent/__tests__/ownership-ledger.test.ts` → RED
  - Commit: `test(ownership): add co-owned→adopted migration tests`

#### Task 2.2: 修复 + 验证
- [ ] **修改**：`src/agent/ownership-ledger.ts:150-158`（`adoptFiles` 函数体）
  - 替换守卫条件：
    ```ts
    function adoptFiles(files: string[]): string[] {
      const adopted: string[] = []
      for (const f of files) {
        // 幂等：已 owned 或已 adopted 的文件跳过
        if (ownedSet.has(f) || adoptedSet.has(f)) continue
        // co-owned → adopted：从共享所有权迁移为独占
        if (coOwnedSet.has(f)) coOwnedSet.delete(f)
        adoptedSet.add(f)
        adopted.push(f)
      }
      return adopted.sort()
    }
    ```
  - 运行测试：`npm exec -- tsx --test src/agent/__tests__/ownership-ledger.test.ts` → GREEN
  - 运行 typecheck：`npx tsc --noEmit` → 0 errors
  - Commit: `fix(ownership): allow adoptFiles to migrate co-owned files to adopted set`

---

## 5. 验证

### 自动化
```bash
# Wave 1
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/hash-edit.test.ts
npm exec -- tsx --test src/tools/__tests__/grep.test.ts

# Wave 2
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/ownership-ledger.test.ts

# 全量
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/hash-edit.test.ts src/tools/__tests__/grep.test.ts src/agent/__tests__/ownership-ledger.test.ts
```

### 手动验证
1. 连续 3 次 hash_edit 同一文件 → 无需中间 re-read（stale recovery 自动处理）
2. deliver_task 对 co-owned 文件 adopt → adoption 成功，文件出现在 owned 列表

---

## 6. Self-check

### Spec coverage
| 需求 | 覆盖任务 |
|------|---------|
| hash_edit 连续编辑不漂移 | Task 1.2 |
| 搜索窗口限制（不扫描全文件） | Task 1.2（SEARCH_WINDOW=50） |
| 找不到时 fail-safe | Task 1.1（stale recovery fails test） |
| position-only 不误恢复 | Task 1.1（position-only fallthrough test） |
| co-owned → adopted 迁移 | Task 2.2 |
| 幂等性 | Task 2.1（idempotent test） |
| 已有测试不退化 | Task 1.3 + 运行全部测试 |

### Placeholder scan
- 无 TODO / TBD / 待定
- 所有测试用例有具体的 assert
- 所有代码块有具体实现

### Type consistency
- `hash_edit` 新增逻辑仅操作已存在的 `Anchor`、`lines`、`filePath` 类型
- `ownership-ledger` 修改仅涉及 `Set<string>` 操作
- 无新类型定义

---

## 7. 执行交付

计划已完成并保存到 `docs/superpowers/plans/2026-06-13-hash-edit-stale-recovery-ownership-fix.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
