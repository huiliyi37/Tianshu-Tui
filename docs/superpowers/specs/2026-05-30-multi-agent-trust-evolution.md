# 多智能体协作信任体系演进

## 背景

**事实：** 今天（2026-05-30）凌晨到深夜，60 个 commit 全部落在同一条分支上，由多个智能体会话并行完成。跨 `src/agent/`、`src/tools/`、`src/tui/`、`src/prompt/` 四个子系统，零崩溃、零返工。

这不是一个 toy demo。这是真实工程中多智能体并行的成功交付。

### 为什么这件事值得记录

市面上的 agent 终端（Claude Code、Cursor、Windsurf 等）默认一个会话绑一个分支或一个 worktree。开新任务 = 开新隔离区。这很安全，但也意味着：

- 分支越多，合并成本越高
- 隔离越严，协作越难
- 上下文越碎片化，人类调度负担越重

我们的方案反其道而行：**多会话共享一条分支**，靠 runtime 归属追踪 + 验证归因 + 交付门禁来保证安全。今天 60 个 commit 证明这条路走得通。

但"走得通"和"走得毫无负担"之间，还有一段距离。本文探查的就是这段距离。

---

## 当前信任体系（已建成）

```
┌─────────────────────────────────────────────────────────────────────┐
│                      多智能体协作信任体系 v1                         │
│                                                                     │
│  WorktreeBaseline ──── 任务启动时拍摄 git 快照                       │
│       │                                                              │
│       ▼                                                              │
│  TaskLedger ──────── 记录 file_write / git_action / verification     │
│       │                                                              │
│       ▼                                                              │
│  OwnershipLedger ──── owned / external / co-owned 三级分类           │
│       │                                                              │
│       ▼                                                              │
│  VerificationAttribution ── 验证失败归因（我的/外部的/模糊的）         │
│       │                                                              │
│       ▼                                                              │
│  DeliveryGateV2 ──── GREEN / YELLOW / RED 三态门禁                   │
│       │                                                              │
│       ▼                                                              │
│  scoped commit ───── 只提交 owned + verified 的文件                   │
└─────────────────────────────────────────────────────────────────────┘
```

**这套体系解决了什么？**

- Agent 不再需要"小心翼翼地猜测哪些文件是自己的"
- 验证失败时能区分"我的锅"和"别人的锅"
- 交付时自动追踪归属，GREEN 即可放心提交
- Stash / undo / reset 只影响 owned 文件

**今天 60 个 commit 的成功依赖的就是这套体系。**

---

## 当前体系的盲区（信任债务）

### 盲区 1：基线陈化

WorktreeBaseline 在任务启动时拍摄一次快照。但另一个会话在运行过程中会持续提交——你启动时的 "external dirty" 可能在 10 分钟后已经变成 "committed by session B"。

**现状影响：** OwnershipLedger 会把"已经被其他会话提交的文件"仍然标记为 external。deliver_task 多数时候仍然能正确工作（因为 scoped commit 只看 owned），但 ownership report 会膨胀为过时的信息。

**信任感受：** Agent 看到 external files 列表很长，会变得谨慎。这不是真风险，是信息陈化造成的虚假风险感知。

### 盲区 2：无跨会话信号

每个会话都是一座孤岛。Session A 不知道 Session B 正在改哪些文件，Session B 不知道 Session A 刚提交了什么。

**现状影响：** 两个会话理论上可能同时修改同一个文件。scoped commit 会发现冲突（因为 git add 只暂存自己的改动），但这个发现来得太晚——在冲突已经发生之后。

**信任感受：** Agent 经常问"这个文件是别的会话在改吗？"。它无法自己回答这个问题。

### 盲区 3：验证失败的全局归因不完整

VerificationAttribution 能区分 "targeted failure = 我的" 和 "full-suite failure = 归因不明"。但它不知道另一个会话是否已经知道这个失败、是否正在修。

**现状影响：** 两个会话可能同时响应同一个 full-suite test failure，形成重复修复。

### 盲区 4：交付信心依赖人类判断

YELLOW 状态的含义是"owned files verified，但存在外部阻塞"。Agent 看到 YELLOW 会犹豫，因为不知道外部阻塞是否严重。实际上大多数 YELLOW 都可以直接交付。

---

## 信任体系演进方向

不是一次性大重构。而是一点一点加。每一步都让 agent 的信任更精准一点、犹豫更少一点。

### 方向 1：活体基线（Living Baseline）

**核心思想：** 基线不是任务启动时拍的照片，是一条随 git 状态自动更新的活线。

```
当前：baseline = snapshot(t=0)  →  永不更新
演进：baseline = snapshot(t=0) + auto_refresh(git state)

当 git status 从 dirty → clean（其他会话提交了），
external files 列表自动收缩。
当新的 untracked 文件出现，如果不在 my ledger 中，自动标记 external。
```

**实现路径：** 在 `deliver_task` 和 `git commit` 的 pre-flight 检查中，重新采集 `git status --porcelain`，与 baseline 对比，更新 external set。

**信任收益：** Agent 看到的 external files 列表始终是当下的，不是历史的。减少虚假谨慎。

### 方向 2：轻量级会话信号（Session Beacon）

**核心思想：** 不需要完整的进程间通信。只需要一个文件。

```
.beacon/<session-id>.json
{
  "taskId": "task-5-fix-bash-timeout",
  "starDomain": "tianliang",
  "activeFiles": ["src/tools/bash.ts", "src/tools/__tests__/bash.test.ts"],
  "heartbeat": 1717048800000,
  "status": "executing"
}
```

**规则：**
- 每次文件写入时更新 beacon
- `deliver_task` 前 read 其他 session 的 beacon，检查文件交集
- 交集文件 → YELLOW with precise warning："Session B (tianliang) 可能也在改 src/tools/bash.ts"
- 心跳超过 10 分钟 → 标记 stale，不再作为阻塞依据

**实现路径：** 新建 `src/agent/session-beacon.ts`。文件写入工具（edit_file、write_file）的 post-hook 中更新 beacon。deliver_task 读取并检查交集。

**信任收益：** Agent 第一次能回答"这个文件有别人在改吗？"。不是猜，是读信号。

### 方向 3：验证结果共享（Verification Pool）

**核心思想：** `tsc --noEmit` 和全量测试是所有会话共享的全局资源。跑一遍就够了。

```
.verification-pool/<hash>.json
{
  "command": "npx tsc --noEmit",
  "status": "passed",
  "timestamp": 1717048800000,
  "sessionId": "session-A",
  "headCommit": "abc1234"
}
```

**规则：**
- deliver_task 检查验证时，先查 pool
- 如果 pool 中有同 command + 同 head commit + 5 分钟内的结果 → 直接复用
- 不再重复跑 `tsc --noEmit`

**实现路径：** `src/agent/verification-pool.ts`。TaskLedger 的 verification 事件写入 pool。deliver_task 优先查 pool。

**信任收益：** 多会话不再重复验证，节省 token 和时间。更重要的是，一个会话的验证结果可被其他会话信任。

### 方向 4：信任等级校准（Trust Calibration）

**核心思想：** 不是所有外部文件都一样。来自已知活跃会话的改动 vs 来自未知来源的改动，信任度应该不同。

```
TrustLevel:
  - OWNED        → 全权信任，直接提交
  - CO_OWNED     → 信任但注意，beacon 检查
  - ALLY_ACTIVE  → 已知活跃会话的文件，可 co-commit
  - ALLY_STALE   → 已知但不再活跃的会话，小心
  - UNKNOWN      → 来源不明，最谨慎
```

**实现路径：** 扩展 OwnershipLedger 的分类，结合 Session Beacon 的状态。

**信任收益：** Agent 的谨慎程度与真实风险匹配，而不是"一律最谨慎"。

---

## 实现优先级

按信任收益 / 实现成本排序：

| 方向 | 信任收益 | 实现成本 | 优先级 |
|------|---------|---------|--------|
| 活体基线 | 高（消除虚假谨慎） | 低（git status 重采） | P1 |
| 会话信号 | 高（首次跨会话感知） | 中（新文件 + hook） | P2 |
| 验证共享 | 中（减少重复劳动） | 低（文件 + 查询） | P3 |
| 信任等级 | 中（精细化） | 中（扩展分类） | P4 |

P1 和 P2 是下一个迭代的核心。P3 和 P4 可以在 P1/P2 验证后再做。

---

## 为什么这不是过度工程

60 个 commit / 天，跨 4 个子系统，零返工。这个数据说明：

1. **需求是真实的** — 多智能体并行不是假设场景，是日常
2. **当前方案是够用的** — v1 信任体系撑住了
3. **但摩擦是存在的** — agent 的谨慎、重复验证、过时信息，都是真实发生的
4. **收益是可量化的** — 每减少一次"帮我看看这个文件是不是有人在改"，就省一轮工具调用

我们不是在建一个理论上的分布式系统。我们在让"今天已经发生的事"变得更丝滑。

---

## 哲学

其他 agent 终端选择**隔离**——每个会话一个 worktree，安全但孤独。

我们选择**共存**——多会话共享一条分支，需要信任但更强大。

信任不是假设。信任是建立在归属追踪、验证归因、交付门禁之上的工程事实。

今天的 60 个 commit 就是证明。明天的演进会让这个证明更不可辩驳。

---

## 评审修正（2026-05-30，基于真实代码核实）

> 方向（共存而非隔离）是对的。但四个方向逐一对照代码后，优先级与实现方式需修正：
> **核心原则——复用已有机制，而非新建并行机制。**

### 修正后的演进序

| 顺序 | 方向 | 修正 |
|---|---|---|
| 1 | P1 活体基线 | 做，但用惰性再分类层（改 ownership-ledger，**不 mutate baseline**），约 30 行 |
| 2 | P2 会话信号 | **不新建 beacon**，复用 SessionRegistry.claims 表，约 60 行 |
| 3 暂缓 | P3 验证共享 | 当前设计有数据正确性 bug，降级为**会话内去重** |
| 4 砍/推迟 | P4 五级信任 | 依赖 P2 且与退行协议冲突，**保留三级** |

### P1 活体基线 — 可做，但问题被高估，有语义陷阱

- **spec 高估**：`delivery-gate-v2.ts:127` 出报告时已 `filter(f => currentDirty.has(f))`，已提交的陈旧 external 已被排除；deliver_task 主路径每次重采 git status。"report 膨胀"在主路径并不严重。
- **真实 gap**：别的会话**新建**的文件（不在 baseline 快照）无法分类 → 未分类脏文件 → 强制 YELLOW。spec 未强调。
- **最高风险**：勿 mutate `WorktreeBaseline`。`coOwnedSet` 语义（ownership-ledger.ts:58-65）依赖 baseline 不变，中途刷新会让同一文件二次注册时错分类；`baselineHash` 是 HEARTH cycle_open 预留输入，刷新埋雷。
- **修正做法**：不动 baseline，在 ownership-ledger 加**惰性再分类层**——`getExternalFiles(currentDirtyFiles)` 求交集 + `_dynamicExternalSet` 收新外部文件。约 30 行，不碰 HEARTH/prefix-cache。

### P2 会话信号 — 严重重复造轮子，勿新建 .beacon/

- **已有三套机制覆盖 90%**：
  1. `SessionRegistry.claims` 表（SQLite，exclusive 锁 + heartbeat + PID 僵尸清理）= 精确的"我在改这些文件且还活着"
  2. `events` 流 + `cross-session-hook` = 已自动注入 `<cross-session-events>`，LLM 已能感知
  3. `SemanticLock` = 内存级文件冲突检测
- **真实缺口**：claims 没在文件写入时自动获取、deliver_task 没查 claims、claims 没注入 prompt。
- **修正做法**：P2 重定义为"**补齐 claims 自动化 + deliver_task 集成 + 注入 prompt**"（约 4 文件 60 行），而非新建 `session-beacon.ts` + `.beacon/`。避免第四套同构机制造成"查 claims 还是 beacon？"的困惑。成本降 ~60%，收益不变。

### P3 验证共享池 — 有数据正确性 bug，当前设计不能做

- **致命缺陷**：缓存键 `command + headCommit + 5分钟` 在本方案前提场景（共享分支 + 脏工作区）下会产生**错误 pass**。会话 A 脏改动通过 tsc → 写池；会话 B 同 HEAD 但脏改动不同（会编译失败）→ 命中缓存拿 "passed" → `delivery-gate-v2.ts:191` 走 GREEN → **把坏代码提交到共享分支**。
- 5 分钟窗口救不了——问题是工作树内容分歧，与时间无关。
- **修正做法**：跨会话复用本质不安全（除非对所有脏文件内容 hash，成本≈重跑）。降级为**会话内去重**（同会话 + 同命令 + 无新文件改动 = 确定性，安全）；`verification-attribution.ts:146` 已有雏形。跨会话共享暂缓。

### P4 五级信任 — 不独立 + 与退行协议冲突，应砍/推迟

- **不独立**：ALLY_ACTIVE/ALLY_STALE 完全依赖 P2；无 P2 则 P4 退化成现有三级（收益为零）。spec 未声明此依赖。
- **认知负担 + 锚点坍缩风险**：ALLY_ACTIVE/ALLY_STALE/UNKNOWN 在 agent **行动层面都映射到同一动作"不是我的，别碰"**，区别只是"为什么"——agent 不需关心。给五个标签是**替 agent 做信任判断**，与退行协议 §0「个体差异不被文档标签压扁」直接冲突。三级直接对应行动权限，更优。
- **ALLY_STALE 制造新虚假谨慎**：跑 11 分钟长测试的会话 beacon 超时变 stale，但文件正在被改——反而引入 spec 想消除的虚假谨慎。
- **修正做法**：保留三级（owned/co-owned/external）。P2 落地后实测 agent 谨慎度，若已合理则不做 P4。

### 落地建议

P1 的惰性再分类层是最小、最安全、零依赖的第一步。其余按修正序推进。


