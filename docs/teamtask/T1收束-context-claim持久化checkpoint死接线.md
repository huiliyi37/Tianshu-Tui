# 【T1 收束】Context Claim 持久化 — checkpoint 死接线与无界增长

> **阶段标记：T1 收束** — 系统架构收束工作（团队级）。
> 基于代码级追踪（每条附 file:line 取证，非推测）。创建：2026-06-06。
> 所属子系统：context claim 生命周期 / JSONL 事件存储（直接喂主上下文 → prefix cache 本愿）
> 关联记忆：[[canonical-memory-write-invariants]]（891cc1b6 incident）、[[t1-convergence-unverified-new-code]]
> 关联链路：本存储是 [子代理工具隔离信任链](./T1收束-子代理工具隔离信任链.md) 的下游（worker findings → `claimStore.propose`）

---

## 0. 结论先行：最纯粹的 T1 纲领案例

`ContextClaimStore` 实现了完整的 Redis Base+Incr 持久化（snapshot + 增量 JSONL replay），
**有设计、有注释、有专门测试**（`claim-store-checkpoint.test.ts`）——
**但 `checkpoint()` 在生产代码里零调用。**

这不是"有 bug 的活跃代码"，而是"造好了、测过了、却从未接进真实生命周期"的代码。
正是 [[t1-convergence-unverified-new-code]] 纲领第二面的极端形态：
**单元测试覆盖 ≠ 集成层被验证。**

---

## 1. 取证：checkpoint 死接线

**生产调用面（排除定义与测试）**：

```
src/agent/session-persist.ts:360  new ContextClaimStore(...)        ← 创建实例
src/agent/session-persist.ts:371  ContextClaimStore.loadDurableClaims(...)  ← 跨会话加载
```

- `loadDurableClaims`（claim-store.ts:250-280）是**静态方法，直接读整份 JSONL**，
  从不读 snapshot。
- `.checkpoint()` 的全部调用点：**仅** `claim-store-checkpoint.test.ts`（3 处）。
  （nightcrawler.test.ts 的 `nc.checkpoint` 是无关的同名方法。）
- `projectClaims` 内的 `loadFromCheckpoint()`（claim-store.ts:323）依赖 snapshot 文件存在；
  因 `checkpoint()` 从不在生产运行 → snapshot 文件从不生成 → `loadFromCheckpoint` **生产中恒返回 null**。

**结论**：snapshot / `checkpoint` / `loadFromCheckpoint` / `snapshotPath` 整套机制**生产中是死代码**。

---

## 2. 死接线带来的三个真问题

### 🔴 P1 — 问题 1：JSONL 无界增长

checkpoint 从不运行 → JSONL **永不 truncate**。每次 `propose / updateClaimStatus /
recordClaimUsed / boostFitness` 都 `appendFileSync` 一行（claim-store.ts:65），
**连 `evictExcessActiveClaims` 驱逐本身也 append 一条 status_changed 事件**（行 84/182）——
所以文件**只增不减**。

- **投影态有界**：active claims 上限 50（`MAX_ACTIVE_CLAIMS`），consumers 上限 50。
- **事件日志无界**：投影态的有界是靠不断 append 驱逐事件实现的，日志反而更快增长。
- **代价**：`readEvents`（claim-store.ts:290）在文件外部 size 变化或首读时 **readFileSync 全文 +
  逐行 reparse**。长会话 → O(事件数) 增长，且这条路径直接喂 prefix-cache 上下文（本愿）。
- **跨会话放大**：每开新会话 `loadDurableClaims`（session-persist:371）读**上一会话的整份 JSONL**。
  上一会话越长，启动读盘越大。

**修法**：把 `checkpoint()` 接进生命周期——按事件数阈值（如每 N 条）或会话结束时触发。
接线前先解决问题 3（非幂等），否则崩溃窗口立刻变活。

### 🟡 P2 — 问题 2：两份并行投影逻辑会漂移

事件 → 投影态有**两份独立实现**：
- `applyEventsToMap`（claim-store.ts:341-392）：处理 proposed / status_changed（含 counterevidence）/
  used（含 cap）/ **boosted**。
- `loadDurableClaims`（claim-store.ts:250-280）：处理 proposed / status_changed / used，
  **不处理 boosted、不处理 counterevidence**。

两份逻辑覆盖同一事件日志却不一致 → 跨会话加载的 durable claim 丢失 boost 后的 fitness、
丢失 counterevidence。更危险的是**维护漂移**：改了一份忘了另一份。

**修法**：`loadDurableClaims` 复用 `applyEventsToMap`（抽成静态/纯函数），消除并行实现。

### 🟡 P2（潜伏）— 问题 3：checkpoint 一旦接线，崩溃窗口致双重 replay

> 当前**不可触发**（checkpoint 死接线），但接线问题 1 时会立刻变活，故预先记录。

`checkpoint()`（claim-store.ts:211-225）是**两个独立原子写**，非单事务：
```ts
writeFileAtomicSync(this.snapshotPath, ...)   // 步骤 1
writeFileAtomicSync(this.path, '')            // 步骤 2：truncate JSONL
```
崩溃落在步骤 1 与 2 之间（snapshot 已写、JSONL 未 truncate）→ 下次加载：
loadFromCheckpoint 读 snapshot（已含这些事件）→ 再 replay **未 truncate 的整份 JSONL**（claim-store.ts:327）
→ 已折叠进 snapshot 的事件被**再应用一次**。

`applyEventsToMap` 的幂等性分裂：
- `claim_proposed`（343）`!claims.has(id)` 守护 → 幂等 ✓
- `claim_boosted`（385）set fitness → 幂等 ✓
- `claim_used`（365-381）`consumers: [...claim.consumers, new]` **append** → **非幂等** ✗
  （双重 replay → 重复 consumer，靠 cap 50 兜底但语义已错）
- `claim_status_changed`（350）非 active 时 append counterevidence → **非幂等** ✗

根因：**snapshot 与 JSONL 位置之间没有 watermark/序号**。Redis Base+Incr 用 AOF offset 记录
snapshot 时的位置；这里用"truncate JSONL"当 watermark，而 truncate 与 snapshot 写之间的窗口无保护。

**修法（接线 checkpoint 时同步做）**：
- A：snapshot 内嵌一个单调 `seq`（已处理到的事件序号）；replay 时跳过 `seq <=` 快照位的事件。
- B：让所有事件应用幂等（used/status_changed 用 set 语义 + 事件去重 by eventId）。
- 推荐 A（与 [[canonical-memory-write-invariants]] 的 monotonic 序号思路一致）。

---

## 3. 已验证为健全的部分（不要误改）

- **截断尾行安全**：`readEvents`（295-300）和 `loadDurableClaims`（256-277）都把 `JSON.parse`
  包在 try/catch 跳过坏行 → 崩溃产生的半写尾行不致命。
- **原子写**：`writeFileAtomicSync`（fs-atomic.ts:11）是 tmp+rename，半写 snapshot 不会出现；
  且有孤儿 .tmp 扫描清理。
- **本地并发 append**：单行 < 4KB 的 `appendFileSync`（O_APPEND）在本地 fs 上单写原子；
  byte-size 缓存失效（claim-store.ts:287）对外部写自愈（重读全文）。
- **投影增量缓存**：`projectClaims`（306-320）用 `lastProcessedLineCount` 做增量 apply，
  常态不全量重算。

---

## 4. 收口建议

```
1. [核心] 问题 1 — 把 checkpoint() 接进生命周期（事件数阈值 / 会话结束）
2. [前置] 问题 3 — 接线前先加 watermark(seq) 或令 replay 幂等（否则崩溃窗口变活）
3. [清理] 问题 2 — loadDurableClaims 复用 applyEventsToMap，消除并行投影
4. [补测试] checkpoint-then-crash（步骤1后/步骤2前）双重 replay 路径；
            长会话 JSONL 增长 + 跨会话加载体量（当前 checkpoint 有测试，
            但"接进生命周期后的崩溃恢复"这条集成路径无覆盖）
```

**与 T1 纲领的关系**：见 [[t1-convergence-unverified-new-code]]。
前三条链路是"裂缝密集"(server 锁)、"健全+残留窗口"(abort 链)，
这第四条是新形态——**完整造好、单测通过、却从未集成**。
收束在此 = 把死接线接活 + 接活前补齐它潜伏的不变量（watermark/幂等）+ 消除并行实现。
三件必须一起做，单独接 checkpoint 会引爆问题 3。

---

## 修复记录

### @ ed36428 — 三问题全部修复（review: `.claude/PRPs/reviews/commit-ed36428-review.md`）
- **问题 1**：`appendEvent` 每 `checkpointEveryEvents`(默认500) 自动 checkpoint，`checkpointing` 守护防重入。
- **问题 2**：`loadDurableClaims` 改为 `new ContextClaimStore(...).listClaims()`，复用统一投影，删除并行实现。
- **问题 3**：事件加 `seq`，snapshot 记 `lastEventSeq`，`projectClaims` 只 replay `seq > 水位` —— 崩溃窗口真闭合。
  专测显式模拟"snapshot 已写、JSONL 未 truncate"崩溃并断言 consumers/counterevidence 不重复。
- typecheck ✅，claim-store 相关 30/30 ✅。零阻塞项，仅 3 LOW（stat 热路径、seq 单写者假设注释、旧 snapshot back-compat 已中和）。
- 旁注：`stigmergy.test.ts` 1/22 失败属**预存**（父提交即失败，与本链路正交），建议单开 issue。