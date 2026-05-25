# readHistory 同文件片段检测 — 实现设计

> 2026-05-26 | 约束：**零 cache miss** — 不改变 read_file 成功读取时的输出格式

---

## 目标

当 agent 已经**全量读取**过一个文件且文件未被修改时，阻止后续对该文件的**片段读取**（不同 offset/limit），避免消息历史因重复读取而膨胀。

---

## 当前行为 vs 目标行为

| 场景 | 当前 | 目标 |
|------|------|------|
| 全量读(src/foo.ts) → 再次全量读 | ❌ 阻断（readHistory 命中） | ❌ 阻断（不变） |
| 全量读(src/foo.ts) → 片段读(offset=100,limit=50) | ✅ 允许重读 | ❌ 阻断（**新增**） |
| 片段读(offset=100,limit=50) → 全量读 | ✅ 允许 | ✅ 允许（片段读不覆盖全量） |
| 全量读 → 修改文件 → 片段读 | ✅ 允许（mtime 变了） | ✅ 允许（不变） |

---

## 设计

### 新增数据结构

```typescript
// 按 canonicalPath 索引，仅记录全量读取
interface FileReadHistoryEntry {
  mtimeMs: number        // 读取时的 mtime，用于失效检测
  totalLines: number     // rawContent 的行数
  rawBytes: number       // rawContent.length
  modelBytes: number     // modelContent.length
  artifactId?: string    // artifactStore ID（如果存在）
  recordedAt: number     // Date.now()
}

const fileReadHistory = new Map<string, FileReadHistoryEntry>()
const FILE_READ_HISTORY_MAX = 200  // 同文件去重不需要太多条目
```

### 判断条件

**记录条件**（写入 fileReadHistory）：
```
offset === 1 && limit === undefined
→ 这是全量读取，记录 canonicalPath → FileReadHistoryEntry
```

**检测条件**（检查 fileReadHistory）：
```
fileReadHistory.has(canonicalPath) 
  && fileReadHistory[canonicalPath].mtimeMs === currentMtimeMs
→ 全量已读 + 文件未变 → 本次任意 offset/limit 都是子集 → 阻止
```

**不需要检查 offset/limit 范围的原因**：全量读取覆盖了所有行（1 到 totalLines），任意 offset ≥ 1 且 offset ≤ totalLines 的请求都是子集。超过 totalLines 的请求由 readFilePayload 自然报错。

### 插入位置

在现有 readHistory 检查之后、readFilePayload 调用之前：

```
execute(params):
  1. resolve canonicalPath, mtimeMs
  2. dedupKey = readHistoryKey(offset, limit)
  3. if readHistory[dedupKey] match → return dedup msg  ← 现有逻辑
  4. if fileReadHistory[canonicalPath] match → return dedup msg  ← 新增
  5. payload = readFilePayload(...)  ← 正常读取
  6. if full read (offset=1, limit=undefined) → fileReadHistory.set(...)  ← 新增记录
  7. recordDedup(artifactId)  ← 现有逻辑
```

### 去重消息格式

与现有 dedup 格式一致，不改变输出协议：

```
read_file: this file was already read in full earlier and has not been modified since.
  file: /path/to/file
  prior result: X bytes raw, Y lines total
  current request: offset=A, limit=B — this range is covered by the earlier full read.

Refer to the earlier tool_result in your context.
Do NOT call read_file for fragments of an already-read file — use your earlier tool_result.
```

如果 prior 读取时有 artifactId，追加 recovery hint：
```
If you can no longer see the earlier result (it may have been compacted),
call read_section(artifactId="...", section="LA-LB") to retrieve it from disk.
```

### 失效机制

与现有 readHistory 相同：**mtime 自然失效**。
- 文件被 edit_file/write_file 修改 → mtime 变化 → fileReadHistory 不匹配 → 允许重读
- 外部修改文件 → mtime 变化 → 同上

不需要主动清理 fileReadHistory（除非 trim）。

---

## 实施清单

### 文件：`src/tools/read-file.ts`

**新增**（在现有 `readHistory` 定义下方）：

1. `FileReadHistoryEntry` interface
2. `fileReadHistory` Map + `FILE_READ_HISTORY_MAX`
3. `trimFileReadHistory()` 函数（与 trimReadHistory 同模式）

**修改**（在 `execute` 方法中）：

4. 在现有 readHistory 检查后、readFilePayload 调用前，插入 fileReadHistory 检查
5. 在 `recordDedup` 调用附近，如果是全量读取 → 调用 `recordFileRead`
6. `__resetReadHistoryForTests` 同时清除 `fileReadHistory`

### 文件：`src/tools/__tests__/read-file.test.ts`

7. 测试：全量读 → 片段读 → 被阻断
8. 测试：全量读 → 修改文件 → 片段读 → 允许（mtime 变了）
9. 测试：片段读 → 全量读 → 允许（未触发 fileReadHistory）
10. 测试：全量读 → 全量读 → 被现有 readHistory 阻断（不依赖 fileReadHistory）
11. 测试：trim 行为（超过 MAX 时清理最旧条目）

---

## 缓存安全性证明

| 检查项 | 结论 |
|--------|------|
| 改变 read_file 成功时的输出格式？ | ❌ 不变。仅新增「去重命中」时的返回消息，不改变成功读取时的 content/uiContent/rawPath |
| 改变 tool definition？ | ❌ 不变 |
| 改变 system prompt？ | ❌ 不变 |
| 改变 engine.ts 的请求构建？ | ❌ 不变 |
| 同一文件多次去重命中，去重消息格式一致？ | ✅ 是 — 格式固定，仅插入具体数值（bytes, lines, offset, limit） |
| readHistory 的现有行为？ | ✅ 不变 — fileReadHistory 是独立 Map，readHistory 的 key 和检查逻辑不变 |

**结论**：✅ 缓存零影响。去重消息（简短、格式固定）替代了可能的大文件全量重读（长、可能波动），反而降低了 prefix 波动的概率。

---

## 不影响的行为

- 修改文件后重读 → 仍允许（mtime 不匹配）
- 首次全量读取 → 仍返回完整内容
- 不同文件 → 各自独立的 fileReadHistory
- 同一文件不同 offset/limit 首次全量读 → readHistory 不命中 → fileReadHistory 不命中 → 正常读取
- 去重消息长度短（~200 chars），不会显著影响上下文
