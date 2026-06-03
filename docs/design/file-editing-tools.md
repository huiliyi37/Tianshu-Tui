# File Editing Tool Chain — Feature Reference

> edit_file, hash_edit, write_file 的完整功能说明。
> 最后更新: 2026-06-04 (commit a26f321)

## 工具概览

| 工具 | 用途 | 安全机制 |
|------|------|----------|
| `edit_file` | 精确字符串替换（old_string → new_string） | stale detection, OOM guard, syntax check |
| `hash_edit` | 行号+内容哈希锚定编辑 | anchor hash verification, syntax check |
| `write_file` | 全量覆写/新建文件 | OOM guard (10MB), syntax check |

## 安全防线（由外到内）

### 1. 路径校验
所有三个工具统一调用 `validatePath()` 拒绝项目目录外的路径。

### 2. OOM 保护
- `edit_file`: 拒绝 >100KB 的文件，引导到 `apply_patch` 或 `sed`
- `write_file`: 拒绝 >10MB 的内容，引导到 `bash heredoc`

### 3. Stale File Detection（edit_file 独有）
read_file 记录每次读取的 mtime。edit_file 在写入前比对：
- **mtime 一致** → 正常编辑
- **mtime 不一致 + old_string 仍匹配** → 自动重新应用（smart recovery）
- **mtime 不一致 + old_string 不匹配** → 展示当前文件内容，建议 hash_edit

### 4. Hash Anchor Verification（hash_edit 独有）
锚点格式: `L<行号>:<SHA256前8位hex>`
- **Full mode**: 验证行号 + 内容哈希，检测文件是否被外部修改
- **Position-only mode** (`L<行号>`): 仅验证行号存在，适用于刚读完文件的快速编辑
- 1-3 个锚点：首尾定义替换范围，中间验证内部完整性

### 5. esbuild 语法检查（三工具共有）
写入 `.ts` / `.tsx` 文件后，自动调用 `esbuild.transformSync` 做语法检查（~2ms）：
- 语法正确 → 无额外输出
- 语法错误 → 在 ToolResult 中追加 `⚠️ Syntax error detected:` 警告，包含行号和错误描述
- 非 TS 文件 → 自动跳过

**效果**: 模型在当前 turn 就能看到语法错误并立即修复，不再需要等 2-3 turns 后的 tsc 才发现。

## edit_file 的 Multiple Match 处理
当 `old_string` 在文件中出现多次时：
- 展示每个匹配位置的行号 + 上下文
- 为每个匹配生成 `hash_edit` anchor hint
- 建议：加长 old_string 或使用 `replace_all=true`

## edit_file 的 Not Found 诊断
当 `old_string` 未找到时：
1. 在文件中搜索与 old_string 首行最相似的行（shared prefix length）
2. 提取相同行数的窗口，生成 unified diff 格式对比
3. 展示 expected vs actual 的差异（通常是缩进/空白不匹配）
4. 自动生成 `hash_edit` anchor hint 作为替代方案

## 错误恢复链路

```
edit_file 尝试编辑
  ├─ stale? → auto-refresh mtime
  │   ├─ old_string 仍匹配 → 重新应用 + syntax check
  │   └─ old_string 不匹配 → 展示当前内容 + hash_edit hint
  ├─ multiple match? → 展示所有位置 + hash_edit anchor
  ├─ not found? → fuzzy match + diff + hash_edit hint
  └─ 成功 → syntax check → 返回结果
```

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/tools/edit.ts` | edit_file 工具实现 |
| `src/tools/hash-edit.ts` | hash_edit 工具实现 + `hashLine()` 导出 |
| `src/tools/write-file.ts` | write_file 工具实现 |
| `src/tools/syntax-check.ts` | esbuild 语法检查函数 |
| `src/tools/read-file.ts` | read_file + mtime 记录/查询 |
| `src/tools/path-validate.ts` | 路径安全校验 |
| `src/tools/__tests__/edit.test.ts` | edit_file 测试 |
| `src/tools/__tests__/hash-edit.test.ts` | hash_edit 测试 |
| `src/tools/__tests__/syntax-check.test.ts` | 语法检查测试 |
