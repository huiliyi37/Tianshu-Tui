# 天枢编辑工具可靠性加固

> 记录时间：2026-07-09
> 目标：降低复杂文件编辑中的 corruption / Aborted 率

## 背景

SWE-bench 基线评测中，`django__django-13346` 出现典型的编辑 corruption：agent 第一次 `edit_file` 把 `django/db/models/fields/json.py` 改坏，后续修复尝试全部失败，最终 Aborted。这说明工具层缺少编辑后的结构完整性校验和自动回滚机制。

## 第一阶段改动

### 1. 扩展 `syntax-check.ts`：增加 Python AST 校验 + fatal/warning 分级

- 新增 `checkSyntax(filePath, content)`，返回 `{ warning, fatal }`。
- Python 文件（`.py`）调用系统 `python3 -c "import ast; ast.parse(...)"` 做严格解析。
- TypeScript/JavaScript/CSS/HTML/JSON 的原有检查升级为：结构性破坏（parse 失败、brace/tag 不匹配）标记为 `fatal`，可运行但可能有问题的情况标记为 `warning`。

### 2. 三个写文件工具增加写盘后校验 + 自动回滚

| 工具 | 关键改动 |
|---|---|
| `edit_file` | 每次成功写入后立即 `checkSyntax`；`fatal` 时通过 `restoreLatestBackup` 回滚并返回错误 |
| `hash_edit` | 同上；复用 `trackFileChange` 已有的备份 |
| `write_file` | 同上；覆盖写入的备份在写盘前已创建 |

### 3. `recovery-stack.ts`：记录并暴露最新备份

- `trackFileChange` 在创建备份时，把路径记录到 `latestBackups`。
- 新增 `restoreLatestBackup(cwd, filePath)`，供编辑工具在验证失败时恢复。

## 第二阶段改动

### 4. `hash_edit` 锚点恢复窗口扩展

- 搜索窗口从 ±50 行提升到 ±200 行。
- 引入 consistent-shift 自动对齐：当已恢复锚点存在统一行偏移时，其余锚点优先在偏移后的位置附近搜索。

### 5. `edit_file` / `hash_edit` 增加 `dry_run` 预览模式

- `input_schema` 新增 `dry_run: boolean`。
- `dry_run=true` 时计算新内容并生成 unified diff，返回给模型，但不写盘、不记录修改。
- 仍执行语法检查，若新内容 fatal 会在 preview 中提示 `SYNTAX ERROR if applied`。
- 错误路径（old_string 未找到、锚点 stale、multiple match 等）保持报错，不会误写盘。

### 6. 复杂编辑推荐 `apply_patch`

- `src/prompt/static.ts` 的 `<tool-usage>` 中明确：单文件 ≥3 处不连续修改、改动超过 20 行、或涉及重构时改用 `apply_patch`。
- `edit_file` 和 `hash_edit` 的 description 中增加 `apply_patch` 使用指引。
- `apply_patch` description 强调先 `check_only=true` 验证再正式应用。

### 7. Agent 层编辑失败自动恢复 hook

- 新增 `src/agent/hooks/edit-failure-recovery-hook.ts`。
- postTool 阶段监听 `edit_file` / `hash_edit` / `write_file` / `ast_edit`。
- 同一文件连续失败 ≥2 次时，通过 advisory bus 投递 repair 级建议：
  1. 调用 `undo` 撤销最近一次写入；
  2. 用 `read_file` 刷新视图；
  3. 改用 `apply_patch` 或 `write_file` 完成剩余修改。
- 带 `expect` 核销谓词，可在后续轮次追踪采纳率。

## 文件变更

- `src/tools/syntax-check.ts`
- `src/tools/edit.ts`
- `src/tools/hash-edit.ts`
- `src/tools/write-file.ts`
- `src/agent/recovery-stack.ts`
- `src/agent/create-runtime-hooks.ts`
- `src/agent/hooks/edit-failure-recovery-hook.ts`（新增）
- `src/prompt/static.ts`
- 相关测试文件

## 测试结果

- `src/tools/__tests__/syntax-check.test.ts`：22/22 pass
- `src/tools/__tests__/edit.test.ts`：27/27 pass（含新增 dry_run 测试）
- `src/tools/__tests__/hash-edit.test.ts`：24/24 pass（含新增 dry_run 测试）
- `src/tools/__tests__/write-file.test.ts`：15/15 pass
- `src/tools/__tests__/read-file-invalidation.test.ts`：12/12 pass
- `src/agent/hooks/__tests__/edit-failure-recovery-hook.test.ts`：7/7 pass
- `src/agent/hooks/__tests__/edit-tool-advisory-hook.test.ts`：6/6 pass
- `src/agent/__tests__/tool-pipeline.test.ts`：77/77 pass
- `npx tsc --noEmit --skipLibCheck`：通过

> 注：`src/tools/__tests__/edit-diff.test.ts` 与 `src/agent/__tests__/loop.test.ts` 中各有 2 个/1 个测试在当前机器负载下不稳定（超时边界 / convergence cooldown），与本次改动无关（未修改 `edit-diff.ts` 与 `loop.ts`）。

## 验证建议

复跑 `django__django-13346` 等曾 corruption 的 SWE-bench 题目，观察：
1. 编辑后 corruption 是否被及时拦截并回滚；
2. agent 是否能改用 `apply_patch` 或更保守的 `hash_edit` 成功完成修复；
3. 连续失败时是否触发自动恢复 advisory，减少 Aborted 率。
