# T1 收束总结 — stall 根因 / abort / 子代理信任链

分支: `fix/stall-root-causes-abort-exit`
状态: **实质工作全部闭环**(2026-06-06)

T1 审查覆盖四条链路 + 若干清理项。下表记录每个发现 → 修复 commit → 验证状态。
所有提交均为精确单文件/单主题提交,未使用 `git add .`,未触碰其他并行会话的工作区改动。

## 1. server 锁链路(cron-lock)

| ID | 缺陷 | 修复 commit | 验证 |
|----|------|------------|------|
| S-1 | 陈旧锁回收脑裂 | 3ffbf0d(源)+ a99e1f2(测试) | hard-link 原子发布 + `.reclaim` 串行化,单 winner |
| S-2 | 锁丢失 → zombie scheduler | 3ffbf0d | onLockLost + markLockLost(仅 owner 触发)|
| S-3 | 非原子 writeLockFile | 3ffbf0d(S-1 顺带) | 旧非原子写已删 |
| S-4 | 损坏锁递归 acquire | 3ffbf0d + 96b01ae | 改为一次 O_EXCL 重试 + 串行化 |
| S-5 | 跨主机锁接管 | e2ab9cc | `owner.hostname !== getHostname()` 守护 |
| S-6 | execSync 阻塞事件循环 | e2ab9cc + 3e2e4e7 | hostname→os;isPidAlive→process.kill(0);**EPERM=alive 防脑裂、/proc 排除 zombie** |

`isPidAlive` 的 EPERM/zombie 正确性由 cron-lock.test.ts 的 `isProcStatZombie` 单测覆盖(含 comm 含 `)` 边界)。

## 2. 子代理信任链(worker evidence / delegate)

| ID | 缺陷 | 修复 commit | 验证 |
|----|------|------------|------|
| P0-1/P0-2 | adversarial_verifier 无 run_tests 仍 verified | b98da5e / ec4e725 | run_tests 缺失 → unverified |
| M2 | 无 transcript fail-open | 923fff5(fail-closed) | 无 transcript → unverified |
| L-1 | run_tests errored 未检 | 923fff5 + 511277a(注释更正) | transcript.errors 字符串匹配 → unverified |
| C-3 | worker claim turn 硬编码 0 | 47db0b5 | 透传 sessionTurnCount |
| C-4 | allowedTools 加载期校验 | 4fef121(revert) | 内置并集是错误权威 → 误拒;dispatch 期 filterToolRegistry 已 fail-fast,故 revert |
| C-5 | 双轨超时 | — | 定性为非 bug(abortSignal 先于 budget timeout) |

## 3. context-claim 持久化(claim-store)

| ID | 缺陷 | 修复 commit | 验证 |
|----|------|------------|------|
| CK-1 | appendEvent 走 statSync | dafb32b | 改用 cachedEvents.length |
| CK-2 | 单写者假设未注明 | dafb32b(顺带) | 注释补齐 |

## 4. 回合边界 abort(compaction-controller)

| ID | 路径 | 守护 | 测试 commit |
|----|------|------|------------|
| A-1 | maybeCompact L279 | ✅ | 5bcf7d3(A-1c)|
| A-1 | enforceContextCeiling L402 | ✅ | 2102ce5(A-1b)|
| A-1 | trySessionSplit L467 | ✅ | ce9d222(A-1)|

三条 abort-after-await 路径与源码三处 `isAbortRequested()` 守护 1:1 对应。

## 5. 其他

| ID | 缺陷 | 修复 commit | 验证 |
|----|------|------------|------|
| C-2 | rtkRewrite 缓存跨 worker bleed | 1679b63 | 缓存键加 toolUseId;**隔离行为在 rtk 未安装时不可观测,未加 test theater** |
| X-1 | stigmergy 持久化测试预存失败 | 952d3f3(测试)+ b6f2144(生产) | 测试补 flush;生产补 session-end flushSync(防 200ms debounce 窗口丢失)|

## 测试诚实性说明

- **C-2**:rtk 未安装时 rtkRewrite 是 no-op,缓存命中/重算输出无差异,黑盒测试无回归信号,故**刻意不加测试**而非凑覆盖。
- **X-1 flushSync**:磁盘内容可观测,测试有真实回归信号,已加。
- 全程未删改或弱化任何既有测试断言。

## 残留项(均非 T1 硬目标)

- 无。L-1-followup(注释)已于 511277a 完成。
- X-1 的 stigmergy flush 已从测试侧延伸修复到生产侧(b6f2144)。

## 验证基线

各修复落地时均跑 `tsc --noEmit`(0 error)+ 对应子系统测试套件全绿:
cron-lock 12/12、compaction-controller 16/16、worker-evidence/profile-registry 33/33、
stigmergy 39/39、bash 28/28。
