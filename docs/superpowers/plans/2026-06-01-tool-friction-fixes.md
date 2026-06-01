# 工具摩擦消除 & 增量测试 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除两个高频工具摩擦点（bash 输出完全抑制、跨项目路径不可读），并引入跨会话可共享的增量测试机制。

**架构：** 三处独立改动，互不依赖，可分别交付。(1) `output-store.ts` 将成功输出从"完全抑制"改为尾部截断，保留信息熵；(2) 新增 `package.json` 脚本 `test:incremental`，基于 git diff 确定变更文件并运行受影响测试，结果写入 `.rivet/test-results.json` 供其他会话查询；(3) `/tmp/` 可读性不修改——安全风险高于收益，改为在 static prompt 中添加 `cp /tmp/x → 项目内 → read_file` 的已知模式提示。

**技术栈：** Node.js 22, TypeScript strict, node:test, bash scripting

---

## 1. Scope Check

三个问题各自独立，无代码依赖：

| 问题 | 子系统 | 可独立交付 |
|------|--------|-----------|
| 问题2: bash suppress | `src/tools/output-store.ts` | ✅ |
| 问题3: 增量测试 | `package.json` + 新脚本 | ✅ |
| 问题1: /tmp/ 路径 | `src/prompt/static.ts` | ✅ |

## 2. File Structure

### 修改的文件

| 文件 | 职责 |
|------|------|
| `src/tools/output-store.ts` | 将成功输出 suppress 改为 tail truncation |
| `src/tools/__tests__/output-store.test.ts` | 更新 suppress 用例 → truncation 用例 |
| `package.json` | 新增 `test:incremental` 和 `test:fast` 脚本 |
| `scripts/test-incremental.ts` | 增量测试脚本 — git diff → 受影响测试 → 运行 → 写入结果 |
| `src/prompt/static.ts` | 添加 /tmp/ 文件读取的已知模式提示 |

### 新建的文件

| 文件 | 职责 |
|------|------|
| `scripts/test-incremental.ts` | 增量测试入口脚本 |

## 3. Research Endorsement

### 3a. output-store.ts suppress → truncation

**要修改的代码** (`output-store.ts:78`):
```typescript
if (meta.exitCode === 0 && lineCount > SUCCESS_INLINE_LINES) {
  return `${header} (success output suppressed; read raw output if needed)`
}
```

**调用链追踪**:
- `buildModelOutput()` 被 `bash.ts:164` 和 `bash.ts:185` 调用
- `bash.ts` 中调用方已附带 `rawPath`（通过 `persistRawOutput`），下游可通过 `cat rawPath` 读取完整内容
- 不存在仅依赖 suppress 文案的下游逻辑（grep 确认无 `success output suppressed` 的 consumer）

**影响范围**: 仅影响 bash 工具的成功输出显示。非零退出码走另一分支（已显示 truncated 内容）。`buildModelOutput` 的 UI 消费方 (`buildUiOutput`) 不受影响。

**风险**: 截断后显示的内容可能被模型误解为完整输出。缓解：截断标记 `[truncated: N lines → M shown]` 已经足够明确。

### 3b. 增量测试脚本

**不存在既有的测试结果缓存**。当前 `npm test` 通过 `find src -name '*.test.ts'` 收集所有测试文件，`tsx --test` 一次性运行。无增量机制。

**related_tests 工具** (`src/tools/related-tests.ts`) 可将源文件映射到测试文件（基于命名约定 `src/X/foo.ts` → `src/X/__tests__/foo.test.ts`）。但这是给模型用的工具函数，不是可调用的 CLI 入口。脚本需要直接复用其文件映射逻辑。

### 3c. /tmp/ 路径 — 不修改

**不对 `validatePathSafe` 做 `/tmp/` 例外**。原因：
1. 安全代价高：一旦放开 `/tmp/`，恶意 prompt 可读取 `/tmp/` 中的任意文件（包括其他进程的临时文件、管道文件等）
2. 已有解法：bash 输出写入 rawPath 后，可用 `read_section` 工具读取 artifact 内容，无需 raw read_file
3. 成本/收益比极低：用户自己也说"这绕一下就行，不痛"

**替代方案**: 在 static prompt 中标注"如遇 `outside project directory`，先用 `cp /tmp/xxx .` 移到项目内再读"。这是零代码变更，纯 prompt 层提示。

## 4. Tasks

### Task 1: bash 成功输出从 suppress 改为 tail truncation

**目标**: 成功命令输出超过 20 行时，不再完全压制，改为显示尾部行 + 截断标记。

- [ ] 修改 `src/tools/output-store.ts:78-79`
  - 将 suppress 分支改为 tail truncation（与 error 路径类似）
  - 新增常量 `SUCCESS_TAIL_LINES = 20`，显示最后 20 行
  - 保留 rawPath 引用提示

```typescript
// 将:
if (meta.exitCode === 0 && lineCount > SUCCESS_INLINE_LINES) {
  return `${header} (success output suppressed; read raw output if needed)`
}

// 改为:
if (meta.exitCode === 0 && lineCount > SUCCESS_INLINE_LINES) {
  const tail = lines.slice(-SUCCESS_TAIL_LINES)
  const omitted = lineCount - SUCCESS_TAIL_LINES
  return `${header}\n... ${omitted} lines omitted ...\n${tail.join('\n')}\n[truncated: ${lineCount} lines → ${SUCCESS_TAIL_LINES} shown]`
}
```

- [ ] 修改 `src/tools/__tests__/output-store.test.ts:57-63`
  - 将 `'suppresses long success output deterministically'` 的断言从 `includes('success output suppressed')` 改为 `includes('truncated')` 和 `includes('lines omitted')`

- [ ] 运行测试验证: `npx tsc --noEmit && npm exec tsx -- --test src/tools/__tests__/output-store.test.ts`
  - 预期: 3 passed, 0 failed

- [ ] 提交: `git commit -m "fix(tools): show tail of success bash output instead of suppressing entirely"`

### Task 2: 增量测试脚本

**目标**: 添加 `npm run test:incremental`，基于当前分支与 main 的差异运行受影响测试，结果写入 `.rivet/test-results.json`。

- [ ] 创建 `scripts/test-incremental.ts`
  - 导入 `node:child_process` (execSync), `node:fs`, `node:path`
  - 逻辑:
    1. `git diff --name-only main...HEAD` 获取变更文件列表
    2. 过滤出 `.ts` 文件（排除 `.test.ts`）
    3. 对每个变更文件，按命名约定推导测试文件路径：
       - `src/X/foo.ts` → `src/X/__tests__/foo.test.ts`
       - 使用 `related_tests` 逻辑（简单版本：`__tests__/` 目录 + `.test.ts` 后缀）
    4. 对已是测试文件的变更，直接加入运行列表
    5. 去重测试文件列表
    6. 运行 `npx tsx --test <files>`，捕获结果（pass/fail/skip）
    7. 写入 `.rivet/test-results.json`：`{ timestamp, commit, passed: [...], failed: [...], skipped: [...] }`
  - 若无变更文件 → 跳过，输出 "No source changes detected, skipping incremental tests"

- [ ] 修改 `package.json` — 新增脚本
  ```json
  "test:incremental": "tsx scripts/test-incremental.ts",
  "test:fast": "tsx --test $(find src -name '*.test.ts' -not -path '*/tui/__tests__/*')"
  ```

- [ ] 运行验证: `npm run test:incremental`
  - 预期: 若当前分支有变更，只运行受影响测试；若当前分支为 main 且无变更，输出 "No source changes"

- [ ] 提交: `git commit -m "feat(test): add incremental test script with cross-session result sharing"`

### Task 3: /tmp/ 路径限制的 prompt 提示

**目标**: 不给 `validatePathSafe` 开口子，而是在 static prompt 中标注已知绕行方案。

- [ ] 修改 `src/prompt/static.ts`
  - 在报错处理段落附近（约第 38-40 行），添加一行：
  ```
  路径报 "outside project directory" 时用 cp 移到项目内再读，例如 `cp /tmp/xxx ./` 然后 read_file。
  ```
  - 不新增独立的 prompt 段落，追加到现有的报错处理指南中

- [ ] 运行 typecheck: `npx tsc --noEmit`
  - 预期: 编译通过（纯注释/字符串改动，无类型影响）

- [ ] 提交: `git commit -m "docs(prompt): add /tmp/ workaround hint for outside-project-directory errors"`

## 5. Verification

### Task 1 验证
```bash
npx tsc --noEmit
npm exec tsx -- --test src/tools/__tests__/output-store.test.ts
```
预期输出: 3 tests passed

### Task 2 验证
```bash
# 在一个有变更的分支上运行
npm run test:incremental
cat .rivet/test-results.json
```
预期: 只运行变更相关测试，结果文件包含 pass/fail/skip 列表

### Task 3 验证
```bash
npx tsc --noEmit
# 确认 prompt 文本包含 /tmp/ 提示
grep -n "outside project directory" src/prompt/static.ts
```
预期: 新行出现在报错处理段落中

## 6. Self-Check

### Spec Coverage
| 需求 | Task | 状态 |
|------|------|------|
| bash suppress → 有信息输出 | Task 1 | ✅ |
| 增量测试 | Task 2 | ✅ |
| /tmp/ 路径提示 | Task 3 | ✅ |
| 不破坏现有缓存 | 改动隔离 | ✅ |

### Placeholder Scan
- ✅ 无 TODO/TBD/待定
- ✅ 所有代码片段可执行
- ✅ 所有文件路径精确

### Type Consistency
- ✅ `output-store.ts` 返回值类型 `string` 不变
- ✅ 测试断言匹配新输出格式
- ✅ `package.json` 脚本名无冲突

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-01-tool-friction-fixes.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
