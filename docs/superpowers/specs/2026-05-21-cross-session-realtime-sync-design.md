# 跨 Session 实时状态同步 + 任务完成度快照 — 深度头脑风暴设计

## 背景

三个模型在不同终端窗口独立运行，自主设计和实现代码。核心问题：
1. Session A 改了接口，Session B 不知道 → 接口定义了但调用方没更新
2. Pheromones（JSON 文件）是跨 session 记忆，但不实时（只在 session 启动时加载）
3. CollaborationProtocol（semantic-lock 等）是纯内存的，多进程之间无法共享

**硬约束**：
- 不能影响 prompt prefix cache（system prompt + tool definitions 的 exact prefix match）
- 不能用 git 操作（git status 变化会影响 volatile block）
- 进程可能随时崩溃，不能留下脏状态

## Scout 调研发现

### Scout 1：跨进程状态同步
- SQLite WAL 是唯一内核级多进程安全方案（ACID 事务消除 race condition）
- JSON 文件的 read-modify-write 有 race condition
- mmap 在 Node.js 中不可用（包已废弃）
- Append-only log 天然避免覆盖竞态

### Scout 2：LLM Prompt Cache 失效机制
- 三家 provider 都是 exact token-level prefix matching
- 从第一个不匹配的 token 开始，后续全部 cache miss
- **Cache-safe 注入方式**：tool result、user message、dynamic appendix（在 stable prefix 之后）
- **绝对不能碰**：system prompt、tool definitions

### Scout 3：蚁群算法/Stigmergy
- 半衰期建议从 7 天放宽到 14 天
- 防洪泛：MMAS 边界（min 阈值裁剪 + 归一化）
- **Alarm pheromone**：独立紧急通道，TTL 2h，不参与衰减
- Batch deposit（session 结束时）优于逐操作更新

### Scout 4：IDE 多窗口状态同步
- VS Code：SQLite + SharedProcess 事件广播
- tmux：Unix domain socket + 单 server
- 推荐：文件系统信号量 + 心跳（与 SessionRegistry 吻合）

### Scout 5：接口未接通检测
- **Knip**：TypeScript unused-export 检测器，JSON 输出
- `tsc --noEmit`：捕获签名不匹配
- 集成路径：session 启动时读取报告注入 context

### 反证 Scout：隐含前提
- **最致命矛盾**：agent 只能通过主动调用 tool 感知状态（否则破坏 cache），但 agent 不知道自己不知道什么（不会主动 poll）
- **解决方案**：被动注入（hook 层），不依赖 agent 主动查询
- SQLite 单写者模型在低频写入时不是问题（busy_timeout 兜底）
- Knip unused-exports ≠ 任务完成度（tsc type errors 更精确）

## 三轮演化过程

### 第一轮：变异（5 个方案）

| 方案 | 生态位 | 核心机制 |
|------|--------|----------|
| V1 | 主流 | SQLite 统一存储 + agent 主动调用 tool 获取状态 |
| V2 | 邻近 | postTool hook 被动注入 + dynamic appendix |
| V3 | 空位 | alerts 目录 + append-only event log（纯文件） |
| V4 | 突变 | 编译时契约（每 turn 跑 tsc） |
| V5 | 组合 | V2 + 启动时 tsc |

### 第二轮：选择

- **V1 灭绝**：因果链断裂（agent 不会主动调用 tool）
- **V4 灭绝**：每 turn 5-15s 延迟不可接受
- **V3 降级**：JSON 文件 race condition 是已知问题
- **V2 存活（最强）**：被动注入 + cache-safe + 利用已有基础设施
- **V5 存活**：V2 + 启动时 tsc 增强

### 第三轮：适应

**最终方案**：V2 + V5 的启动时增强

核心设计：在已有的 SessionRegistry SQLite 中加一个 `events` 表，通过 postTool hook 写入 + preTurn hook 读取 + dynamic appendix 注入。

## 最终方案

### 架构

```
Session A (postTool hook)          Session B (preTurn hook)
        │                                   │
        ▼                                   ▼
  ┌─────────────┐                    ┌─────────────┐
  │ SQLite      │                    │ SQLite      │
  │ events 表   │◄───── WAL ────────►│ events 表   │
  └─────────────┘                    └─────────────┘
        │                                   │
        │ INSERT event                      │ SELECT new events
        │                                   ▼
        │                            ┌─────────────────┐
        │                            │ dynamic appendix │
        │                            │ (cache-safe)     │
        │                            └─────────────────┘
        │                                   │
        │                                   ▼
        │                            LLM sees:
        │                            <cross-session-event>
        │                              Session A 修改了 aggregation.ts
        │                            </cross-session-event>
```

### 为什么这个方案 cache-safe

1. `events` 表的内容通过 dynamic appendix 注入
2. dynamic appendix 是 `cachedFreshBlock` 的一部分，在 `frozenBase` 之后
3. `frozenBase` 构成 fingerprint 的 `stableVolatileSha256`
4. dynamic appendix 不参与 fingerprint 计算
5. 因此 events 内容变化不会导致 cache drift

### 信息流

1. Session A 执行 `edit_file` → postTool hook 触发
2. Hook 向 SQLite events 表 INSERT 一条记录
3. Session B 的下一次 tool 执行前，preTurn hook 触发
4. Hook 从 events 表 SELECT 新事件（created_at > lastChecked AND session_id != mine）
5. 事件格式化后注入 dynamic appendix
6. LLM 在下一轮自然看到跨 session 信息

### 任务完成度快照

Session 启动时异步跑 `tsc --noEmit`，把 type errors 写入 events 表（priority=1）。
其他 session 在 preTurn hook 中优先读取 priority=1 的事件。

效果：Session B 启动后第一轮就知道 "coordinator.ts:322 — aggregateResults 期望 3 个参数但只传了 2 个"。

## 风险与应对

| 风险 | 应对 |
|------|------|
| SQLite SQLITE_BUSY | `busy_timeout` pragma 设为 3000ms；写入频率低（每次 tool 执行一次） |
| dynamic appendix token 膨胀 | 每次最多注入 5 条最新事件；events 有 TTL（2h 自动清理） |
| tsc 启动检查慢 | 异步执行，不阻塞 session；超时 15s 放弃 |
| 进程崩溃留下孤儿事件 | events 有 TTL 自动过期；不影响其他 session |

## 下一步

见实现计划：`docs/superpowers/plans/2026-05-21-cross-session-realtime-sync.md`
