# 按需读取：repo_map + 大文件优化分析

> 日期: 2026-05-27
> 状态: 分析完成，待执行 P1

## 1. 问题背景

模型在理解项目时面临两个矛盾：
- **信息太少**：看不到全貌，无法定位代码
- **信息太多**：一次性灌入整个目录树或大文件，浪费 context window

核心问题：**当前工具缺少「渐进式探索」能力**，模型要么拿全量数据，要么什么都没有。

## 2. 现状分析

### 2.1 repo_map（`src/tools/repo-map.ts`）

| 维度 | 当前值 | 说明 |
|------|--------|------|
| 深度限制 | MAX_DEPTH = 4（硬编码） | 不可配置 |
| 文件数限制 | max_files = 200（可配置） | 达到上限后跳过剩余文件 |
| 输出行数 | 无上限 | 仅靠文件数间接控制 |
| 排除目录 | node_modules, .git, dist 等 | 合理 |
| 文件注释 | [entry] [test] [config] [doc] | 帮助定位 |

**问题**：
1. 对大型项目（500+ 文件），200 文件的树仍然很大（~300-500 行输出）
2. 没有按目录聚焦的能力 — 模型无法说「只看 `src/agent/` 下面的树」
3. 没有「先浅后深」的渐进策略 — 总是一次性输出最大深度

### 2.2 read_file（`src/tools/read-file.ts`）

| 维度 | 当前值 | 说明 |
|------|--------|------|
| 字符上限 | 8,000 chars（默认） | 通过 `computeModelReadCap()` 动态调整 |
| offset/limit | 支持 | 1-based 行号切片 |
| 100KB 守卫 | 无 offset/limit 时拒绝 | 防止意外读大文件 |
| 截断策略 | head 60% + tail 30% | 字符级截断，可能截断行中间 |
| artifact 存储 | 超阈值时自动包装 | 完整内容存 artifact，模型看摘要 |
| 去重机制 | readHistory + fileReadHistory | 防止重复读取相同未修改文件 |
| 日志文件 | >16KB 触发 preview | head 80 行 + tail 80 行 |

**问题**：
1. 默认 8,000 字符对一个 500 行 TS 文件不够（约 15-20KB）
2. `computeModelReadCap()` 需要传入 `contextWindow` 才能动态生效，但调用链可能未正确传递
3. 全量 `readFileSync` 后再切片 — 对超大文件效率低
4. 字符级截断破坏行完整性

### 2.3 repo_graph（`src/tools/repo-graph.ts`）

| 维度 | 当前值 | 说明 |
|------|--------|------|
| 模式 | graph / impact | graph 返回关联文件，impact 返回影响范围 |
| token 预算 | 2,000（可配置） | 控制返回文件数 |
| 索引方式 | 增量式 | 读/编辑文件时自动构建 |
| 输出截断 | 15,000 chars | 硬上限 |

**这是目前最接近「按需」的工具** — 从一个文件出发，按结构关联性查找相关代码。

### 2.4 model-read-cap（`src/tools/model-read-cap.ts`）

```
单次工具调用字符预算 = contextWindow × 5% × 4(chars/token) × strategy_multiplier
```

| provider 策略 | 乘数 | 128K 窗口 | 1M 窗口 |
|---------------|------|-----------|---------|
| cache-preserving | 1.3 | ~33K chars | ~260K chars |
| balanced | 1.0 | ~25K chars | ~200K chars |
| aggressive | 0.65 | ~16K chars | ~130K chars |

**关键发现**：如果 contextWindow 正确传入，128K 窗口下单次可读 ~25K 字符（~300-400 行代码），完全够用。问题在于 `contextWindow` 是否在调用链中正确传递。

## 3. 架构关系

```
模型进入项目
  │
  ├─ 1. inspect_project() → 快速概览（语言/框架/入口/测试）
  │
  ├─ 2. repo_map() → 目录树全景
  │     └─ 问题：一次给太多，无法聚焦
  │
  ├─ 3. read_file(path) → 读取具体文件
  │     ├─ 小文件：完整返回
  │     ├─ 中等文件：head+tail 截断
  │     └─ 大文件：拒绝或 artifact
  │
  ├─ 4. repo_graph(from_file) → 按图探索关联
  │     └─ 最接近「按需」的工具
  │
  └─ 5. grep/glob → 按模式搜索
```

理想的渐进探索流程：
```
inspect_project → repo_map(shallow) → 选中目录 repo_map(deep)
                                       → read_file(关键文件)
                                       → repo_graph(关联分析)
```

## 4. 优化方案

### P1: repo_map 支持目录聚焦（最小改动，最大收益）

**目标**：让模型能指定只看某个子目录的树，而不是全项目。

**改动**：
- 新增 `path` 参数（可选，默认 cwd）— 指定要查看的子目录
- 新增 `depth` 参数（可选，默认 4）— 允许模型请求浅层预览
- 保持向后兼容：不传参数时行为不变

**实现位置**：`src/tools/repo-map.ts`

**示例用法**：
```
repo_map()                        → 全项目浅层 (depth=2)
repo_map({ path: "src/agent/" })  → agent 目录深层树
repo_map({ depth: 2 })            → 全项目浅层概览
```

### P2: read_file 动态容量生效验证

**目标**：确保 `computeModelReadCap()` 的动态计算真正在调用链中生效。

**改动**：
- 验证 `contextWindow` 从 `ToolCallParams` → `read_file execute` → `computeModelReadCap()` 的传递链
- 如果断链，修复传递
- 添加诊断日志

### P3: repo_map 输出增加文件大小提示

**目标**：在目录树中标注文件大小，帮助模型决定是否需要按范围读取。

**示例输出**：
```
├── main.ts [entry] 12KB
├── utils.ts 3KB
└── huge-data.json 2MB
```

### P4: 截断改为行级（可选）

**目标**：`truncateContent` 从字符级截断改为行级截断，避免在行中间断开。

## 5. 优先级排序

| Phase | 影响 | 难度 | 风险 | 建议 |
|-------|------|------|------|------|
| P1 | 高 | 低 | 低 | ✅ 立即执行 |
| P2 | 高 | 低 | 低 | ✅ 紧跟 P1 |
| P3 | 中 | 低 | 低 | P1/P2 稳定后 |
| P4 | 低 | 中 | 中 | 视情况决定 |

## 6. P1 实现计划

### 6.1 接口变更

```typescript
interface RepoMapInput {
  max_files?: number   // 已有
  path?: string        // 新增：聚焦的子目录
  depth?: number       // 新增：目录深度（覆盖 MAX_DEPTH）
}
```

### 6.2 核心逻辑变更

1. `buildTree()` 接受动态 `maxDepth` 参数（替换硬编码 `MAX_DEPTH`）
2. `execute()` 中根据 `path` 参数调整起始目录
3. `formatTree()` 路径前缀显示相对路径（聚焦子目录时）

### 6.3 测试计划

- 测试 `path` 参数聚焦子目录
- 测试 `depth` 参数限制深度
- 测试不传参数时向后兼容
- 测试 `path` 不存在时的错误处理
- 测试 `path` 指向文件时的行为

### 6.4 影响范围

- `src/tools/repo-map.ts` — 主要改动
- `src/tools/__tests__/repo-map.test.ts` — 新增测试
- `src/prompt/static.ts` — 更新工具使用说明（可选）
