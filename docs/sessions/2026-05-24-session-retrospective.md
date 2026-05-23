# 会话复盘：2026-05-24 迭代记录

> 会话焦点：解决 agent 协作中的实际痛点 + 完善 team 协作设计文档

---

## 实现清单

### 1. Artifact Intercept 反套娃修复（`5335480`）

**痛点**：read_file/grep/bash 输出超过 800 chars 就被截断为 artifact ref，agent 需要 3-5 轮 read_section 才能看到代码（"俄罗斯套娃"）。审查场景 80% 轮次浪费在读自己的工具输出上。

**方案**：
- 读取类工具白名单（read_file, grep, glob, find_files, search, repo_map, inspect_project）→ 阈值 8000 chars
- bash 只读命令检测（cat, grep, git log/diff/status, ls 等）→ 同等待遇
- MAX_ARTIFACT 从 2000 → 4000
- explore 阶段乘数从 0.5 → 1.0
- budget-aware 缩放：context 空间充裕时阈值 ×3，紧张时不缩放

**关键文件**：`src/agent/tool-pipeline.ts`（artifactIntercept 函数）、`src/cache/adaptive-threshold.ts`、`src/cache/advisor.ts`

**设计文档**：`docs/design/artifact-intercept.md`

**验证**：typecheck 通过 + 42 tests 全绿

---

### 2. Meridian Code Graph（`cbf9798`）

**痛点**：接手他人代码时 40% 时间花在读代码理解依赖关系上。

**方案**：增量式代码图索引系统
- tree-sitter WASM 解析 → 提取 symbols/edges/imports
- SQLite 持久化 → 跨 session 复用
- spreading activation → 从 seed 文件 BFS 扩散找相关代码
- postTool hook → read_file/write_file 自动触发索引
- `repo_graph` tool → agent 可主动查询结构上下文

**关键文件**：`src/repo/meridian-*.ts`（parser, db, graph, indexer, types）、`src/agent/hooks/meridian-hook.ts`、`src/tools/repo-graph.ts`

**设计文档**：`docs/meridian-architecture.md`

**验证**：17 tests 全绿

---

### 3. Git 格式陷阱防御（本会话未提交）

**痛点**：agent 写 git 解析代码时猜 `status --porcelain` 的列偏移，`slice(3)` 漏掉路径首字符。4 轮 debug 才修好。

**方案**：在 system prompt `<git>` 规则中追加约束：
> "When parsing git output programmatically, use machine-stable formats: --name-only, -z, or --format=. Never hand-parse status --porcelain column offsets."

**关键文件**：`src/prompt/static.ts` L99-103

**效果**：所有后续会话（含 worker）写 git 解析代码时有明确约束，不会再猜列偏移。

---

### 4. 测试 Setup 断言防御（本会话未提交）

**痛点**：`git stash` 在 clean working tree 上静默成功（exit 0）但不创建 entry。测试 setup 没断言 → 后续断言指向被测代码而非 setup 本身。

**方案**：
- 新增 `gitStash()` helper：断言 stash entry 确实被创建，否则立即 fail
- 替换所有裸 `git stash` 调用为 `gitStash()`
- system prompt `<tdd>` 规则追加：
  > "In test setup, assert that preconditions hold. Silent no-ops in setup cause misleading test failures."

**关键文件**：`src/agent/__tests__/workspace-guard.test.ts`、`src/prompt/static.ts` L65-69

**效果**：未来 agent 写测试时会主动断言 setup 操作的效果。

---

### 5. 协作方案文档完善（`eff4328`）

**痛点**：mimo 的概念推演缺乏与现有代码的映射，无法直接指导实现。

**方案**：
- 保留原始概念推演为 `-original.md`（团队讨论记录，用于复盘）
- 重写主文件为工程 spec：每个概念映射到现有模块、标注实现状态、给出接口定义和插入位置

**关键修正**：
- 信息素从"完成后单向通知"改为"启动时声明 scope + 过程中持续沉积"
- 去掉预设轮次，用 CognitiveSeason 自然转换
- 守火人 = cerebellar gate + scope 检查（不引入新角色）
- 义务是语义级目标，不是工具列表

**文件**：
- `docs/superpowers/specs/2026-05-23-agent-collaboration-scenario.md`（工程 spec）
- `docs/superpowers/specs/2026-05-23-agent-collaboration-scenario-original.md`（概念留存）

---

### 5. Degraded 模式允许 edit_file（本会话未提交 → 已实现）

**痛点**：debug 到第 4 轮时系统触发 degraded mode，`edit_file` 被无条件阻止，无法修改代码验证假设，被迫纯靠推理修 bug。

**根因分析**：
- `degraded` 模式的目的是降低资源消耗（防止 OOM、磁盘爆满）
- `write_file` 有风险：可能创建大文件
- `bash` write 有风险：可能 fork 进程链
- 但 `edit_file` 是低风险的：修改已有文件的小 diff，不创建新进程，不增加磁盘占用

**方案**：`degraded` 模式下允许 `edit_file`，仅阻止 `write_file` 和 bash write。

**关键文件**：`src/agent/reliability-mode.ts` L73-76

**效果**：debug 场景下 agent 仍然可以"改代码 → 跑测试"循环，不会被降级保护卡死。`write_file` 仍然被阻止（防止创建大文件），bash read 命令（git log/diff/status）本来就允许。

---

## 迭代方向（下一步）

| 优先级 | 方向 | 依赖 |
|--------|------|------|
| P0 | scope-claim 信息素：worker 启动时声明 scope | StigmergyStore 已就绪 |
| P0 | scope 边界 gate：worker 尝试修改非 scope 文件时阻止 | scope-claim |
| P1 | HEARTH Phase 1：anchor-graph.ts + INV-1~5 | 无 |
| P1 | 义务引擎：语义级目标追踪 | 无 |
| P2 | Meridian 多语言支持 | tree-sitter WASM |
| P2 | Meridian 自动注入 top-3 相关文件到 system prompt | Meridian 稳定后 |
| P3 | A/B 测试锚位格式（XML vs 扁平文本） | HEARTH Phase 1 |

---

## 经验教训

1. **止血优先**：artifact intercept 的 800 chars 阈值是最直接的效率杀手，提到 8000 后审查场景立即改善
2. **prompt 规则 > 代码 gate**：对于"agent 行为习惯"类问题（猜格式、不断言 setup），在 prompt 中加一行规则比写复杂的 gate 逻辑更有效且零运行时开销
3. **概念文档和工程文档分离**：概念推演有留存价值（复盘、规划），但不能直接当实施 spec 用。两者应该共存但分文件
4. **增量索引 > 全量索引**：Meridian 选择"agent 接触时才索引"，零启动延迟，1-hop expand 缓解首次不完整
