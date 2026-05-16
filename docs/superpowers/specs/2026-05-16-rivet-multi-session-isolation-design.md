# Rivet 多会话并行隔离 — 深度头脑风暴结果

## 背景

用户需求：在开启多个 TUI 终端并行开发时，不同 session 之间是否互相污染？

项目上下文：Rivet 是基于 Ink 6 + React 的终端编码 Agent，支持 DeepSeek V4 prefix cache 优化、sub-agent 协调、checkpoint/rollback 等能力。Phase 2 能力开发已完成（20 capabilities Verified）。

## 调研发现（3 个并行子代理）

### Scout 1：模块级单例扫描

扫描 `src/` 中所有模块级可变状态，发现 14 个单例/缓存：

| 文件 | 变量 | 存储内容 | 按 cwd 隔离? | 跨进程风险 |
|------|------|---------|-------------|-----------|
| `src/main.tsx:73` | `shutdownCallback` | 全局 shutdown hook | 否 | 低（独立进程） |
| `src/main.tsx:76` | `_pipedInput` | stdin 管道输入 | 否 | 低 |
| `src/main.tsx:80` | `_coordinatorRef` | DelegationCoordinator 引用 | 否 | 低 |
| `src/main.tsx:83` | `_mcpManager` | McpManager 实例 | 否 | 低 |
| `src/prompt/volatile.ts:32` | `rivetMdCache` | .rivet.md 缓存 per-cwd Map | 是 | 低（已按 cwd 隔离） |
| `src/prompt/volatile-git.ts:68` | `gitStatusCache` | git status 缓存 per-cwd Map | 是 | 低 |
| `src/tools/read-file.ts:9` | `gitignoreCache` | GitignoreFilter per-cwd Map | 是 | 低 |
| `src/tools/todo.ts:19` | `defaultStore` | 内存 todo 列表 | 否 | 低（独立进程） |
| `src/tools/process-tracker.ts:3` | `activeProcesses` | 子进程注册表 | 否 | 低 |
| `src/tools/output-store.ts:10` | `persistCount` | raw output 清理计数器 | 否 | 低 |
| `src/tools/web-fetch.ts:19` | `turndown` | TurndownService 单例 | 否 | 低 |
| `src/tui/log-state.ts:10` | `_nextLogId` | 日志 ID 单调递增计数器 | 否 | 低 |
| `src/tui/theme.ts:103` | `activeTheme` | 当前主题名 | 否 | 低 |
| `src/tui/use-terminal-size.ts:8` | `cachedSnapshot` | 终端尺寸缓存 | 否 | 低 |

**关键发现**：所有单例都在各自 Node 进程内。每个 TUI 启动是独立进程，所以这些单例**不会跨进程共享**。cwd-keyed 的缓存（rivetMdCache、gitStatusCache、gitignoreCache）已在之前 Cache Safety 修复中改为 per-cwd Map。

### Scout 2：会话/进程架构分析

| 组件 | 实例化方式 | 隔离状态 |
|------|-----------|---------|
| TUI 启动 | 每次 `node dist/main.js` = 独立 Node 进程 | 安全 |
| AgentLoop | `useMemo(() => new AgentLoop(...))` per Root | per-instance |
| SessionContext | `new SessionContext()` per Root / per worker | per-instance |
| PromptEngine | `new PromptEngine(...)` per AgentLoop | per-instance |
| ToolRegistry | `createDefaultToolRegistry()` per Root | per-instance |
| McpManager | `new McpManager(config.mcp)` per Root | per-instance |
| TraceStore | `createTraceStore()` per AgentLoop, 纯内存 | per-instance |
| **Checkpoint** | `~/.rivet/checkpoint-<cwd>.json`，writeFileSync 无锁 | **共享 per cwd** |
| **Session JSONL** | `~/.rivet/sessions/<sessionId>.jsonl`，appendFile 无锁 | **共享 per session ID** |
| **Session memory** | `~/.rivet/sessions/<sessionId>.memory.json` 无锁 | **共享 per session ID** |
| **Session ID** | `~/.rivet/session-id.txt` 固定值 | **全局共享** |
| Sub-agents | 同进程内 `runWorkerSession()`，独立内存 | 内存安全，文件共享 |

**关键发现**：内存中所有组件完全隔离。真实风险仅在文件系统：session-id.txt（固定 ID → 所有 TUI 写同一 session 文件）、checkpoint 文件（按 cwd 命名 → 同 cwd 的 TUI 互相覆盖）。

### Scout 3：行业调研

**行业标准方案**：

| 产品 | 多实例隔离方式 |
|------|--------------|
| Claude Code | `claude --worktree` + `--tmux`，每个 agent 在独立 worktree |
| Cursor 2.0 | git worktree 或远程机器，最多 8 个并行 agent |
| Aider | 社区推荐 git worktree 模式 |
| Amux/Canopy/QuadCode | tmux session + git worktree 组合 |

**关键发现**：
- **行业共识**：git worktree = 文件系统隔离的 table stakes
- **无产品用 file lock 做跨进程隔离** — advisory lock 只在所有参与者遵守协议时有效
- **Ink 限制**：同一进程同一 stdout 只能有一个 `render()` 调用
- **Runtime 隔离问题**（即使有 worktree）：端口冲突、共享数据库、`.env` 碰撞、API rate limit 倍增
- **proper-lockfile** 是 Node.js 生态最推荐的 advisory lock 库（mkdir 原子操作 + staleness 检测）

**证据分层**：
- 事实：每个 TUI 是独立进程（不可改变的架构约束）
- 现状：session-id.txt 固定 ID（可改变的设计选择）
- 惯例：行业用 worktree（可质疑但广泛验证的惯例）
- 假设：「同一 cwd 不应有两个 TUI 同时运行」（未验证的假设——实际上是可以的，只需文件隔离）

## 三轮思考过程

### 第一轮：变异

#### 1.1 生态位测绘

- **行业**：终端编码 Agent（与 Claude Code、Cursor、Aider 竞争同一生态位）
- **用户群**：单人开发者，多任务并行（写代码 + 跑测试 + 审查）
- **技术约束**：TypeScript + Ink 6，单进程 per TUI，文件系统共享 `~/.rivet/`
- **选择压力**：多 TUI 并行不能互相污染 + 零配置 + 实现成本可控
- **已占据生态位**：Claude Code (worktree + tmux)、Cursor (worktree + 远程机器)
- **空生态位**：Rivet 目前无任何多实例隔离机制

#### 1.2 变异生成（4 个方案）

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1(主流) | Worktree + 文件锁 | 让 Rivet 用 proper-lockfile 保护所有文件写入，同时检测 worktree 状态 |
| V2(邻近) | Session ID 唯一化 | 让 Rivet 每次启动生成 UUID session ID，session/checkpoint 文件自然按 ID 隔离 |
| V3(空位) | IPC 协调器 | 让 Rivet 用 Unix socket 在进程间协调，检测同 cwd 已有实例 |
| V4(突变) | 纯 worktree 原生 | 让 Rivet 默认每次新 session 自动创建 git worktree，物理隔离文件系统 |

#### 1.3 创始者效应检查

隐含假设：「用户会在同一个 checkout 目录下打开多个 TUI」— 这个假设**关闭了** V4 的方案空间。但如果默认行为改为 worktree，这个场景就不存在了。需在第二轮验证这个假设是否合理。

#### 1.4 适应度函数

- **硬约束**：不改变单实例用户的行为（没有多实例时一切如常）
- **加分维度**：零配置自动隔离、与已有 session 管理功能共演化
- **减分维度**：增加启动延迟、增加用户操作步骤、引入新依赖

#### 1.5 调研整合

- **Scout 1 发现**：所有单例在独立进程内，cwd-keyed 缓存已隔离 → 内存安全，风险在文件系统
- **Scout 2 发现**：checkpoint 按 cwd 命名无锁、session-id.txt 固定值 → 核心冲突点明确
- **Scout 3 发现**：行业都用 worktree，无产品用 file lock → V1 的 lock 方向可能是逆行业惯例

### 第二轮：选择

#### 2.1 目标重注入

重新阅读用户原始请求：「在开启多个 tui 终端的情况下，不同 session 并行开发的能力怎么样，会污染吗」

核心目标：确保多 TUI 并行时不互相污染。不是"选哪种技术方案"，而是"最小成本解决实际冲突"。

#### 2.2 因果压力测试

**V1 (Worktree + file lock)**：
- 因果链：file lock → 同一时刻只有一个进程写文件 → 不冲突
- **因果断裂点**：advisory lock 只在所有参与者遵守协议时有效。Rivet 是开源项目，用户可能直接用编辑器打开 checkpoint JSON，绕过 lock。且 lock 增加每次文件写入的延迟。
- 证据性质：**惯例** — 行业不用 file lock 做跨进程隔离，这不是硬约束，但说明 lock 方案不成熟

**V2 (Session ID 唯一化)**：
- 因果链：UUID session ID → 每个 TUI 写不同的 session 文件 → 不冲突
- 通过。但 checkpoint 文件仍按 cwd 命名（`checkpoint-<cwd-slug>.json`），两个 TUI 在同一 cwd 仍然写同一个文件。
- **部分因果断裂**：checkpoint 的设计意图是「按 cwd 恢复到上次状态」，改为按 session ID 命名需要保留 cwd index。
- 证据性质：**现状** — checkpoint 按 cwd 命名是可改变的设计选择

**V3 (IPC coordinator)**：
- 因果链：IPC → 检测同 cwd 已有实例 → 提示或切换
- **因果断裂**：Unix socket 不支持 Windows（Rivet 目标平台之一）。coordinator 进程崩溃 = 所有 TUI 失去协调。实现复杂度高（IPC 协议设计 + 跨平台抽象 + 故障恢复）。
- 证据性质：**事实** — 跨平台兼容性是不可改变的技术约束

**V4 (纯 worktree 原生)**：
- 因果链：worktree → 物理隔离文件系统 → 不可能冲突
- 通过。但非 git 项目不支持 worktree。worktree 创建有延迟（1-2秒）。需要管理 worktree 生命周期（清理）。
- 证据性质：**事实** — git worktree 需要 git 仓库（不可改变的前提）

#### 2.3 成本-收益压力测试

| 方案 | 开发成本 | 维护成本 | 机会成本 | 风险成本 |
|------|---------|---------|---------|---------|
| V1 | 中（集成 proper-lockfile，改所有文件写入点 ~10 个函数） | 中（lock 超时配置、死锁检测、staleness 处理） | 放弃 V2 的 session 管理共演化 | lock 不被遵守时完全无效 |
| V2 | 低（改 session ID 生成 + checkpoint 命名 ~20 行） | 低（UUID 是标准库） | 无（与 V4 可组合） | checkpoint index 文件仍有极低概率冲突 |
| V3 | 高（IPC 协议设计 + 实现 + 测试 > 1 周） | 高（跨平台维护、故障恢复逻辑） | 放弃快速修复窗口 | 新单点故障 |
| V4 | 中（worktree add/prune API 封装 + session 生命周期） | 中（worktree 泄漏管理、磁盘空间监控） | 无（与 V2 可组合） | 非 git 项目不适用 |

#### 2.4 共演化检测

- V1：**静态** — file lock 是纯防御机制，不推动任何新功能
- V2：**动态** — UUID session ID 天然支持 session 管理功能（`/sessions` 列出、`/resume` 恢复、`/delete` 清理），且为未来 session 分享/导出打基础
- V3：**静态** — IPC coordinator 只解决协调问题，不产生新用户可见能力
- V4：**动态** — worktree 模式天然支持并行开发（不同 feature 分支），与 Rivet 的多任务编排场景共演化

#### 2.5 局部最优陷阱检测

V4（纯 worktree）看起来是"最安全"的方案，但它是**过度方案** — 大部分场景下两个 TUI 只是编辑不同文件，不需要物理隔离整个仓库。V2 的 UUID session ID + checkpoint 改进已经足够解决实际冲突，且改动量只有 V4 的 1/3。V4 可以作为 V2 之后的增强。

#### 2.6 落地性测试

| 方案 | 第一步具体动作 | 可衡量指标 |
|------|--------------|-----------|
| V1 | `npm install proper-lockfile` → 改 checkpoint.ts 加 lock acquire/release | lock acquire 延迟 < 5ms |
| V2 | `crypto.randomUUID()` 替代 `getOrCreateSessionId()` 的文件读取 | session 文件不再冲突 |
| V3 | 设计 IPC 协议 JSON schema → 实现 Unix socket server | 跨平台测试通过 |
| V4 | 封装 `git worktree add` → 实现 `createWorktreeSession()` | worktree 创建 < 2s |

#### 2.7 灭绝与留存

```
灭绝: V3 — 原因：实现成本高（IPC 协议 + 跨平台 + 故障处理），引入新单点故障，收益不如 V2+V4 组合
存活: V1(弱·安全网) / V2(强·最小改动) / V4(中·彻底方案)
最强竞争者: V2 — 理由：最小改动解决 session 文件冲突 + 与 session 管理功能共演化 + 可与 V4 组合
新发现: V2 和 V4 可以组合——V2 解决 session/checkpoint 文件冲突（Phase 1-2），V4 作为进阶选项提供物理隔离（Phase 3）
```

**discarded_trait 回收**：
- V3 的「检测同 cwd 已有实例」特征 → 可以简化为「启动时检查 checkpoint index 是否有其他 session 的记录，提示用户」，不需完整 IPC

### 第三轮：适应

#### 3.1 反套路扫描

「加 file lock」是行业条件反射——看到"多进程写同一文件"就想加 lock。但 Rivet 的 checkpoint 冲突是 **last-write-wins 语义**（JSON 覆盖写），不会导致数据损坏（不会出现半个 JSON 的情况），只是丢失其中一个 TUI 的 checkpoint。file lock 的成本（每次写操作 +5ms lock acquire/release + staleness 检测 + 死锁防护）远超收益（防止极低概率的 checkpoint 覆盖）。

正确做法不是"保护写入"，而是"消除冲突"——让两个 TUI 写不同的文件。

#### 3.2 扩展适应搜索

1. **SessionContext 的 per-instance 设计**（刚实现的 bounded collections）→ 天然支持多实例，无需改动
2. **已有的 `<sessionId>.jsonl` 命名规则**（session-persist.ts）→ 只要 session ID 不同，文件自然隔离
3. **已有的 checkpoint 系统**（checkpoint.ts）→ 可扩展为 session-scoped，用 sessionId 替代 cwd 作为文件名
4. **已有的 `/sessions` 和 `/resume` 命令**（app.tsx）→ 自然支持多 session 管理

#### 3.3 具体化（人-场-动-果）

- **人**：一个开发者，在同一个 feature 分支上开两个 TUI（一个写代码，一个跑测试/审查）
- **场**：同一个 git checkout 目录，两个终端窗口（tmux 或 iTerm 分屏）
- **动**：TUI-A 修改 src/a.ts 并 checkpoint，TUI-B 修改 src/b.ts 并 checkpoint
- **果**：两个 checkpoint 都正确记录各自修改的文件，`/rollback` 时只回滚对应 TUI 的修改

#### 3.4 收敛验证

V1（file lock）和 V2（UUID session）收敛到「文件写入需要命名空间隔离」。
V4（worktree）收敛到「物理隔离是最安全的」。
**共同洞察**：Rivet 的多实例问题本质是 checkpoint 文件的命名空间问题——当前用 cwd 作为 key，应该用 session ID。

#### 3.5 实施路径设计

（见下方「最终方案」章节）

## 最终方案：三阶段渐进式隔离

### Phase 1（最小可行验证）— Session ID 唯一化

**改动**：
- `src/main.tsx`：每次启动生成 `crypto.randomUUID()`，不再依赖 `~/.rivet/session-id.txt`
- Session JSONL 和 memory 文件自然按 session ID 隔离（已有的 `<sessionId>.jsonl` 命名规则）
- 保留 `session-id.txt` 的写入（用于 `/sessions` 列表），但启动时不再从文件读取

**预期产出**：两个 TUI 同时运行，各自的 session 文件不互相覆盖

**成功标准**：`ls ~/.rivet/sessions/` 显示两个不同的 session 文件，各自内容独立

**退出条件**：如果 resume 功能依赖固定 session ID，需要设计 session list/选择机制

### Phase 2（扩展验证）— Checkpoint 隔离

**改动**：
- `src/agent/checkpoint.ts`：checkpoint 文件改为 `checkpoint-<sessionId>.json`
- 新增轻量 cwd index：`checkpoint-index-<cwd-slug>.json` 记录 `{sessionId, files, timestamp}`
- `rollbackToCheckpoint()` 支持选择回滚哪个 session
- SummaryBar 显示当前 session 的 checkpoint 文件数

**预期产出**：两个 TUI 在同一 cwd 各自 checkpoint，rollback 互不影响

**成功标准**：TUI-A 的 `/rollback` 不会回滚 TUI-B 修改的文件

**退出条件**：如果 index 文件有冲突风险，加 `proper-lockfile` advisory lock

### Phase 3（规模化）— Worktree 感知

**改动**：
- `src/tui/summary-bar.tsx`：检测 git worktree 状态，显示 worktree 名称
- 新增 `/new-worktree <branch>` 命令：`git worktree add` + 切换 cwd
- 新增 `/worktree-list` 命令：列出所有 worktree 和对应 session 状态
- 自动清理：session 结束时提示是否删除 worktree

**预期产出**：用户一条命令启动隔离的并行开发环境

**成功标准**：`/new-worktree feature-a` 自动创建 worktree 并切换

**退出条件**：如果 worktree 创建失败（磁盘空间、git 限制），fallback 到普通模式

## 风险与应对

| 脆弱点 | 影响 | 应对 |
|--------|------|------|
| Phase 2 的 checkpoint index 文件仍有跨进程写入风险 | 极低概率 last-write-wins | Phase 3 的 worktree 彻底消除 |
| 非 git 项目不支持 worktree | Phase 3 不可用 | Phase 1-2 仍然有效（session ID 隔离） |
| Session ID 唯一化后 `/sessions` 列表可能过长 | 用户体验 | 添加 session 过期清理（7天TTL） |
| 用户不知道其他 TUI 在修改同一文件 | 功能性冲突（非数据损坏） | Phase 3 的 worktree 模式 + 未来可加 file watcher 提示 |

## 当前状态诊断（直接回答用户问题）

**结论：当前多 TUI 并行时，内存层面不会互相污染，但文件层面存在 3 个冲突点。**

| 风险点 | 严重度 | 现状 | 修复方案 |
|--------|--------|------|---------|
| `session-id.txt` 共享固定 ID | **中** | 两个 TUI 写同一个 session 文件 → 数据交叉 | Phase 1：UUID session ID |
| `checkpoint-<cwd>.json` 按 cwd 命名 | **低** | 同 cwd 两个 TUI 的 checkpoint 互相覆盖（last-write-wins） | Phase 2：按 session ID 命名 |
| `sessions/*.jsonl` 无文件锁 | **低** | 同 session ID 的两个进程追加写同一文件 | Phase 1 自然消除（UUID） |

**最佳实践**：在 Phase 1 修复前，用户可以通过在不同 git worktree 中启动 TUI 来手动实现隔离。

## 下一步

实现计划已保存到 `docs/superpowers/plans/2026-05-16-rivet-multi-session-isolation-implementation.md`。

6 个任务：
1. Session ID 唯一化（改 main.tsx）
2. Checkpoint 按 session ID 隔离（改 checkpoint.ts）
3. 更新 checkpoint 调用方（改 loop.ts + app.tsx）
4. Rollback 支持选择 session
5. 向后兼容旧 checkpoint
6. README + 最终验证
