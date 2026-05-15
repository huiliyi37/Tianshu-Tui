# Rivet 开发能力补强 Phase 2 实施计划

> 日期: 2026-05-15 | 分支: feat/rivet-dev-capability-phase2

## 背景

Phase 1（性能优化）已完成。Tool prompt 集成经核实已内置在 definition 中。
当前核心缺口是缺少搜索工具——没有 grep/glob，agent 无法高效定位代码，只能用 bash 绕路。

## 任务 1：grep 工具

**文件：** 创建 `src/tools/grep.ts`, `prompts/tools/grep.md`

实现基于 `ripgrep` (`rg`) 的代码搜索工具：
- 支持正则/字面搜索
- 支持路径过滤（`--glob`）
- 结果截断（max 100 行）
- 自动排除 `.gitignore` 中的文件 + `node_modules/.git/dist/.next/`

```typescript
// grep tool contract
{
  name: 'grep',
  description: 'Search file contents with regex or literal patterns...',
  input_schema: {
    pattern: string,       // regex or literal pattern
    path?: string,         // search scope (default: cwd)
    glob?: string,         // file filter e.g. "*.ts"
    max_results?: number,  // default 100
    literal?: boolean,     // literal vs regex
  }
}
```

## 任务 2：glob 工具

**文件：** 创建 `src/tools/glob.ts`, `prompts/tools/glob.md`

```typescript
{
  name: 'glob',
  description: 'Find files matching a glob pattern...',
  input_schema: {
    pattern: string,       // glob pattern e.g. "src/**/*.ts"
    path?: string,         // search root (default: cwd)
  }
}
```

## 任务 3：注册新工具 + 更新 system prompt

**文件：** 修改 `src/main.tsx`, `src/tools/registry.ts`

在 `Root` 组件中注册 grep/glob 工具。更新 `static.ts` 的搜索策略描述。

## 验证

- `npx tsc --noEmit` 0 errors
- `npx tsx --test` 所有已有测试通过
- grep/glob 新增测试通过
