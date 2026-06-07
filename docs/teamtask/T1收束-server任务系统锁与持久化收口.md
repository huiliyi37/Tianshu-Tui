# 【T1 收束】Server 任务系统 — 锁与持久化收口

> **阶段标记：T1 收束** — 系统架构收束工作（团队级）。
> 基于代码级追踪（每条附 file:line 取证，非推测）。创建：2026-06-06。
> 所属子系统：server 层 daemon cron / TaskRegistry（Spec A 改造二 + Spec B）
> 关联 spec：`../superpowers/specs/2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease-修订正式版.md`
> 关联架构母文档：`../architecture-overview.md`

---

## 0. 背景与定位

server 层是最新提交（`9e0e746`→`3be9ca8`）的子系统：独立 cron-scheduler + cron-lock + TaskRegistry。
广度侦察（测试覆盖 + 同步阻塞 + 并发面）发现这是 T1 当前**覆盖盲区最集中**处：

| 文件 | 行数 | 测试 | 风险面 |
|------|------|------|--------|
| **cron-lock** | 233 | ✗ **零测试** | PID 租约锁、陈旧回收、健康检查 |
| **task-store** | 200 | ✗ **零测试** | 原子持久化、并发读写 |
| cron-scheduler | 290 | ✓ | — |
| task-registry | 340 | ✓ | — |
| task-routes | 241 | ✓ | — |

`cron-lock` 的存在理由是「保证多进程中**恰好一个**当 scheduler」。下列裂缝中，#1 直接违反这个理由。

---

## 1. 裂缝清单

| # | 问题 | 性质 | 后果 | 工作量 |
|---|------|------|------|--------|
| 1 | 陈旧锁回收非原子 → 脑裂 | 🔴 违反锁的存在理由 | 两进程同时当 scheduler，cron 双重执行 | 中 |
| 2 | 丢锁检测无回调 → 僵尸 scheduler | 🔴 检测是死路 | 锁被抢后本进程仍持续触发 cron | 小-中 |
| 3 | `writeLockFile` 非原子写 | 🟡 与自身 task-store 模式不一致 | 半写锁文件被读 → 触发误清理路径 | 小 |
| 4 | 损坏锁的 forceRelease + 递归 acquire | 🟡 竞态删活锁 + 无界递归 | 误删活进程的锁；FS 持续失败时栈溢出 | 小 |
| 5 | `isPidAlive` 不防 PID 复用 / 跨主机 | 🟡 多主机假设破裂 | PID 重用→误判存活；NFS 共享→错判 | 中 |
| 6 | `execSync('ps')` 阻塞事件循环 | 🟡 server 卡顿 | 抢锁/健康检查同步阻塞最长 2s | 小 |

---

## 🔴 P0 — 裂缝 1：陈旧锁回收非原子 → 脑裂（split-brain）

**取证**：`cron-lock.ts:142-153`。owner 已死时，直接 `writeLockFile`（普通 `writeFileSync`）覆盖：

```ts
if (!isPidAlive(owner.pid)) {
  const newInfo = { pid: process.pid, ... }
  writeLockFile(this.lockPath, newInfo)   // ← 非原子，无 O_EXCL 保护
  this.state = { status: 'stale_recovered', ... }
  ...
}
```

**问题**：O_EXCL 只保护**全新创建**（行 110），**不保护陈旧回收**。两个进程可同时
（a）O_EXCL 失败 →（b）都读到同一个死 owner →（c）都 `isPidAlive===false` →
（d）都 `writeLockFile` 自己的 PID → **两个都认为自己是 owner**。

`cron-lock` 的全部价值（恰好一个 scheduler）在陈旧回收窗口失效，导致 cron 任务双重执行。

**修法**：陈旧回收也走 O_EXCL 语义——先 `unlink` 旧锁再 `openSync(path,'wx')` 重建，
失败则说明已被别人接管 → 退回 `contended`。或引入"回收意图"两阶段（写 `.recovering` 标记 + rename）。

---

## 🔴 P0 — 裂缝 2：丢锁检测无回调 → 僵尸 scheduler

**取证**：`isOwner()` 只在 `cron-wiring.ts:76` 的 `start()` **检查一次**。scheduler 启动后，
`checkHealth`（`cron-lock.ts:225-231`）每 10s 能检测到锁被篡改/丢失并标记 `contended`，
但**没有任何回调通知 scheduler 停止**：

```ts
private checkHealth(): void {
  const owner = readLockFile(this.lockPath)
  if (!owner || owner.pid !== process.pid) {
    this.state = { status: 'contended', owner: ... }  // ← 只改 state，无 onLockLost
  }
}
```

**后果**：与裂缝 1 叠加——脑裂后锁被另一进程抢走，本进程的 `checkHealth` 标记 contended，
但 scheduler 照常 tick → **僵尸 scheduler 持续触发 cron**。检测有眼睛没有手。

**修法**：`CronLock` 暴露 `onLockLost(callback)`；`checkHealth` 检测到非自己持有时触发回调；
`cron-wiring` 注册回调 → `scheduler.stop()`。让检测有牙齿。

---

## 🟡 P1 — 裂缝 3：writeLockFile 非原子写（与自身 task-store 不一致）

**取证对比**：
- `cron-lock.ts:80-82` — `writeFileSync(path, ...)` 直接写，**无 tmp+rename**。
- `task-store.ts:104-107` — **同一子系统**却用 `writeFileSync(tmp)` + `renameSync(tmp,final)` 原子写。

锁文件半写时被另一进程 `readLockFile` 读到 → `JSON.parse` 失败 → catch 返回 null →
触发裂缝 4 的 forceRelease 误清理路径。

**修法**：`writeLockFile` 改用 task-store 已有的 tmp+rename 模式。子系统内原子写策略统一。

---

## 🟡 P1 — 裂缝 4：损坏锁的 forceRelease + 递归 acquire 竞态

**取证**：`cron-lock.ts:128-131`。锁文件 parse 失败（owner=null）时：

```ts
if (!owner) {
  this.forceRelease()   // ← unlink 任意锁，不论 owner
  return this.acquire() // ← 无界递归
}
```

**问题**：`forceRelease` 删**任何**锁。竞态：A 持有效锁，B 的 O_EXCL 失败，B 在 A 正写锁的瞬间
读到半写内容（裂缝 3）→ owner=null → B **强删 A 的锁** → 两者都能 acquire。
且 FS 持续失败时 `acquire()` 无限递归 → 栈溢出。

**修法**：依赖裂缀 3 修复（原子写消除半写）；递归改成带上限的重试循环；
forceRelease 仅在确认 owner 不存活时调用。

---

## 🟡 P1 — 裂缝 5：isPidAlive 不防 PID 复用 / 跨主机

**取证**：`cron-lock.ts:54-66`。只检查 `ps -p <pid>` 是否有输出，不校验是否**同一进程**。
`LockInfo` 有 `acquiredAt` + `hostname`（行 24-28）但**从不用于消歧**。

**问题**：
- **PID 复用**：崩溃+重启后 PID 被无关进程占用 → `isPidAlive===true` → 锁永不回收（假争用）。
- **跨主机**：注释声称支持「多进程各起 server」，若 `.rivet` 在 NFS 共享，
  `ps -p <localpid>` 跑的是**本机** PID，对远端 owner 的 PID 可能巧合存在 → 错判存活。
  `hostname` 字段记了却没在存活判定里比对。

**修法**：存活判定加 `hostname` 匹配（非本机 → 用 acquiredAt 超时回收，而非 ps）；
本机用 `acquiredAt` + 进程启动时间交叉验证防 PID 复用（或写入更强的 owner token）。

---

## 🟡 P1 — 裂缝 6：execSync 阻塞 server 事件循环

**取证**：`isPidAlive`（行 56 `execSync('ps')`，timeout 2s）、`getHostname`（行 203 `execSync('hostname')`）。
在 server 进程里，抢锁遇到争用/陈旧锁时 execSync 同步阻塞事件循环最长 2s；
健康检查路径虽不直接 execSync，但任何回收触发都会。

**修法**：PID 存活探测改 `process.kill(pid, 0)`（不发信号只测存在，纯 syscall 无子进程）；
hostname 用 `os.hostname()`（node 内建，无 execSync）。两处都能去掉子进程 spawn。
> 注：`process.kill(pid,0)` 不区分 zombie，需与裂缝 5 的 owner token 方案配合。

---

## 2. task-store 旁注（同子系统，待补测试）

`task-store.ts` 的原子写本身正确（tmp+rename，行 104-107），但：
- **零测试**：原子写、并发 list、损坏 JSON 恢复路径全无覆盖。
- `list()`（行 128-129）逐文件 `readFileSync` + `JSON.parse`，单个损坏文件是否中断整个 list 需确认。

→ 补测试时一并验证：原子写中断恢复、并发写同 id、损坏文件跳过而非全失败。

---

## 3. 建议执行顺序

```
1. [先做] 裂缝 3（原子写）— 它是 1 和 4 的公共前置
2. [核心] 裂缝 1 + 2 — 脑裂 + 僵尸 scheduler，锁的存在理由
3. [跟进] 裂缝 6（去 execSync）+ 4（递归→重试上限）
4. [设计] 裂缝 5 — owner token / 跨主机，需小设计
5. [补课] cron-lock + task-store 零测试 → 按项目惯例补 __tests__
```

**与 sub-agent 链路的共性**：两条链路的裂缝都属同一类——**新代码"看似完成但未验证"**，
关键并发/持久化路径缺测试。T1 收束的本质就是给这些基础件补上「真验证」。

每项落地后回填本表「状态」，并补 `src/server/__tests__/*.test.ts`。