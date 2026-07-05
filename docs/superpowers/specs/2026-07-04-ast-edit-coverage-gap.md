# ast_edit 写工具覆盖缺口 — 统一兼容方案

> **状态：** 调研文档。`ast_edit` 在多文件批量 AST 编辑场景中已被三个
> 检测器遗漏——需要统一补上，而非各处零散修补。

## 问题空间

四个写工具中，三个（`edit_file` / `write_file` / `hash_edit`）共用
`{ file_path: string }` 单文件 + `{ new_string/content: string }` 单内容
的输入模式。`ast_edit` 不同：

```
ast_edit 输入:
  ops: [{ find: string, replace: string }, ...]  // 多个 op，每个 replace 是写入内容
  paths: string[]                                  // 多文件
  dryRun: boolean                                  // true=仅预览
```

`dryRun: true` 时不实际写盘，只返回 diff——此时不应触发检测。

## 受影响检测器

| 文件 | 当前覆盖 | 缺口 | 影响 |
|------|---------|------|------|
| `src/agent/hooks/dead-end-detector.ts` | `EDIT_TOOLS = {edit_file, write_file}` | 缺 `hash_edit`, `ast_edit` | `ast_edit` 的修改文件不标记"等待验证"，死路盲区 |
| `src/agent/probe-detector.ts` `extractWriteContent()` | 三工具，返回单对象 | 缺 `ast_edit`，返回类型需扩展为数组 | `ops[].replace` 中的 `console.log` 漏检 |
| `src/agent/hooks/external-claim-tracking-hook.ts` | `WRITE_TOOLS = {edit_file, hash_edit, write_file, apply_patch}` | 缺 `ast_edit` | delegate 报告→`ast_edit` 修改不触发未核验告警 |

## 方案

### 新建：`src/tools/write-tool-helpers.ts`

统一导出所有写工具相关常量和内容提取函数，单一事实来源。

```typescript
// 所有写工具名（供各检测器引用）
export const WRITE_TOOL_NAMES = new Set([
  'edit_file', 'write_file', 'hash_edit', 'ast_edit', 'apply_patch',
])

export interface WriteFileContent {
  filePath: string
  content: string
}

/**
 * 从任意写工具的 input 中提取 (文件路径, 写入内容) 列表。
 * ast_edit 返回多个条目（每个 op 的 replace 内容），
 * 其余工具返回单条目。dryRun 的 ast_edit 返回空数组。
 */
export function extractWriteContents(
  toolName: string,
  input: Record<string, unknown> | undefined,
): WriteFileContent[] { ... }

/**
 * 从任意写工具的 input 中提取文件路径列表（不需要内容时用）。
 * 如 dead-end-detector 只需知道哪些文件被编辑过。
 */
export function extractWriteFilePaths(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string[] { ... }
```

### 改：三个检测器统一 import

| 文件 | 改动 |
|------|------|
| `dead-end-detector.ts` | `EDIT_TOOLS` → import `WRITE_TOOL_NAMES`；文件路径从 `tool.input?.file_path` 改为 `extractWriteFilePaths(tool.name, tool.input)` |
| `probe-detector.ts` | `extractWriteContent` 弃用，新增 `detectProbesFromWriteTool(toolName, input)` 包装函数调用 `extractWriteContents` 后逐条 detectProbes |
| `probe-tracking-hook.ts` | 调用改为 `extractWriteContents` 取值 |
| `external-claim-tracking-hook.ts` | `WRITE_TOOLS` → import `WRITE_TOOL_NAMES`；`getWriteFilePath` 改为 `extractWriteFilePaths` |

### 不改：`apply_patch`

`apply_patch` 输入是 unified diff 文件路径，不是被修改的目标文件路径——它的语义和四个编辑工具完全不同。`external-claim-tracking-hook` 已在 `WRITE_TOOLS` 中包含它，但 `getWriteFilePath` 对它的处理是 best-effort（取 `input.path`）。本轮不改变这个现状，`apply_patch` 使用频率极低。

### 数据流

```
ast_edit input { ops: [{find, replace}, ...], paths: [...], dryRun? }
       │
       ▼
extractWriteContents(toolName, input)
       │ dryRun? → []
       │ 否则 → paths × ops → [{ filePath, content: op.replace }, ...]
       │
       ├─→ probe-detector.detectProbes() → 逐 content 扫描探针
       ├─→ dead-end-detector: 逐 filePath 标记 editPending
       └─→ external-claim-tracking: 逐 filePath 比对声称集合
```

### 测试

- `src/tools/__tests__/write-tool-helpers.test.ts`：覆盖 ast_edit 多文件多 op、dryRun 返回空、单文件工具兼容
- 现有三个检测器的测试需要增补 ast_edit 用例（如 dead-end 的 ast_edit→verify 循环、probe 的 ops 中含 console.log）
