# P2.1 开发能力层实施计划

> 日期: 2026-05-15 | 分支: main | 状态: ✅ 已完成
> 前提: Phase 1 性能地基 + Phase 2 grep/glob 已完成
> 验证: 162 tests, 0 failures, TS clean

## 目标

让 Rivet 能完成真实的 repo editing 闭环：理解项目 → 定位代码 → 编辑 → 查看 diff → 运行测试 → 恢复。

## 已完成（前序阶段）

| 能力 | 状态 |
|------|------|
| 非阻塞 volatile context | ✅ |
| TUI render batching | ✅ |
| 增量 token accounting | ✅ |
| smart compact | ✅ |
| abort-aware retry | ✅ |
| fingerprint 完整化 | ✅ |
| grep 工具 | ✅ |
| glob 工具 | ✅ |

## 任务 1：diff 工具

**文件：** 创建 `src/tools/diff.ts`、`src/tools/__tests__/diff.test.ts`

```typescript
{
  name: 'diff',
  description: 'Show git diff for working tree changes — staged, unstaged, or per-file.',
  input_schema: {
    staged: boolean,       // --cached
    path: string,          // filter to specific file/dir
    context_lines: number, // default 3
  }
}
```

实现：`git diff` + `git diff --cached`。输出截断，每文件最多 200 行。

## 任务 2：run_tests 工具

**文件：** 创建 `src/tools/run-tests.ts`、`src/tools/__tests__/run-tests.test.ts`

```typescript
{
  name: 'run_tests',
  description: 'Run project tests and return parsed results — exit code, failures, duration.',
  input_schema: {
    filter: string,     // test name pattern for targeted run
    timeout: number,    // default 120s
  }
}
```

实现：
- 自动检测 package manager（npm/yarn/pnpm）
- 自动检测 test command（从 package.json scripts）
- 解析常见测试框架输出（node:test、jest、vitest）
- 返回：exit code、failed tests list、error details、duration
- 输出截断，只保留失败信息和摘要

## 任务 3：inspect_project 工具

**文件：** 创建 `src/tools/inspect-project.ts`、`src/tools/__tests__/inspect-project.test.ts`

```typescript
{
  name: 'inspect_project',
  description: 'Return project summary: language, package manager, scripts, entry files, test command, framework hints.',
  input_schema: {}  // no params needed, operates on cwd
}
```

实现：读取 package.json → 解析 scripts/test/build/lint → 检测 framework（next/react/vite/nest/express）→ 检测 language（ts/js）→ 列出入口文件 → 列出测试结构。

## 任务 4：register 新工具 + 更新 system prompt

**文件：** 修改 `src/main.tsx`、`src/prompt/static.ts`

注册 diff / run_tests / inspect_project 到 ToolRegistry。更新系统 prompt 的搜索策略和工具使用指导。

## 任务 5：repo map 最小版本

**文件：** 创建 `src/tools/repo-map.ts`

```typescript
{
  name: 'repo_map',
  description: 'Return a condensed file tree with key entry points and test structure.',
  input_schema: {
    max_files: number,    // default 200
  }
}
```

实现：
- 生成文件树（深度限制 4 层）
- 标注入口文件（main、index、app）
- 标注测试文件
- 标注配置文件
- 排除 node_modules/.git/dist/build/.next

## 任务 6：checkpoint + rollback

**文件：** 修改 `src/agent/session-persist.ts`，新增 `src/agent/checkpoint.ts`

checkpoint 能力：
- 每次 agent 开始修改前自动创建 git commit（带 `[rivet-checkpoint]` 标记）
- `/rollback` slash command 回滚到最后 checkpoint
- 退出时自动清理 checkpoint commits
- checkpoint 包含修改前后文件列表和 diff summary

## 任务 7：evidence badge（最终报告）

**文件：** 修改 `src/agent/loop.ts`、`src/tui/app.tsx`

在 agent 完成时追加 evidence summary：
```
--- Evidence ---
Files read: 5
Files modified: 2
Tests run: ✅ 12 passed
Unverified: ❌ typecheck not run, integration tests skipped
Risks: edit in shared module may affect 3 callers
```

## 验证

每任务完成后运行：
```bash
npx tsc --noEmit && npx tsx --test <new_test_file>
```

全部完成后：
```bash
npm test  # all tests including existing 93
npm run build
```

## 任务依赖

```
Task 1 (diff) ──────┐
Task 2 (run_tests) ─┤
Task 3 (inspect)  ──┤ 并行 Wave 1
Task 5 (repo-map)  ─┤
                     ├──> Task 4 (register + prompt) ──> Task 7 (evidence)
Task 6 (checkpoint) ─┘  (depends on diff)
```
