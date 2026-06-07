# 待办:volatile.test.ts 先前就存在的 hang + 陈旧断言

**日期:** 2026-06-07
**分支:** `main`(工作区,本次 6 处测试修复未提交)
**状态:** ⏳ **待安排**(已 root-cause,用户将自行排期;**与本次 6 处修复无关**,stash 验证确认)

---

## 一句话

`src/prompt/__tests__/volatile.test.ts` 会**死锁挂起**,拖垮单进程全套(`npm test` 在该文件停在 ~600s)。`git stash` 掉本次全部改动后**仍挂** → 先前就存在,不在本次修复触及的代码(`src/prompt/`)里。

## 根因(已完整定位)

死锁在 `worktree-warning dynamic appendix` 这个 describe。单个测试不挂,2 个以上一起跑才挂:

1. `buildStableVolatileBlock` 会把 `gitStatus` 置 `undefined`(`volatile.ts:154`)。
2. 于是 `buildVolatileBlockInternal:258` 的 `ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)` **必然**走到 `gitStatusCache.get()`。
3. `gitStatusCache.get()`(`volatile-git.ts:57-63`)里 `void this.refresh(cwd)` —— 在**同步**构建 prompt 的过程中 **fire-and-forget** 启动一个 git 子进程。
4. 测试用假 cwd `/project`(本机不存在),该 spawn 在同步测试**已经返回之后** ~2ms 才 reject。
5. node:test 检测到这个悬挂 promise → 报 `'Promise resolution is still pending but the event loop has already resolved'` → 死锁整个 describe(并与该 describe 内的断言失败叠加)。

这与本次已修复的 `/test` mkdir 泄漏是**同一家族**(同步流程中 fire-and-forget 异步 + 假 cwd)。参见 `test-orphan-process-investigation.md` 与本次修复的 5 个 loop 测试。

## 另含:~6 个陈旧断言失败(独立于 hang)

输出格式漂移导致的断言失败(与挂起是两回事):
- `<decisions recent="2">`
- `<worktree-warning severity="yellow">` / `severity="red">`
- tool-history 的 count 属性
- 等

这些需要把测试里期望的字符串与当前 `buildVolatileBlock` 的真实输出对齐。

## 修复建议(排期后)

- **消除 hang:** 在测试 cwd 上预热 `gitStatusCache`(或改用真实 temp git 目录),让 `get()` 不再触发悬挂的 `refresh()`。
  - ⚠️ 注意 tsx 双模块实例陷阱:从测试侧 import 调 `prime()` 可能命中与 `volatile.js` 不同的 cache 实例,导致预热无效(本次排查已踩过)。用真实 temp git 目录更稳。
- **修陈旧断言:** 对照当前 `buildVolatileBlock` 输出逐条核对期望字符串。

## 影响面

单进程 `npm test` 会卡在该文件 ~600s 超时;分目录跑则不受影响(本次 agent/ 全套 2027/2027 绿即在隔离该文件后取得)。

## 同族新发现:`src/tui/__tests__/slash-commands.test.ts`(2026-06-07 追加)

`handleSlashCommand` 在 plan-mode 接线(commit `b52f154`)后变 `async`。旧测试以 `assert.equal(handleSlashCommand(ctx), true)` **同步**调用 —— Promise 永不 `=== true/false`,24 个断言**同步抛错**,进程在任何悬挂 promise 生效前退出(`cancelled 0`),所以"看起来能跑完"。

把测试改成 `await`(正确:生产侧 `app.tsx:764` 已 await)后,断言**真正通过**;通过的 async 测试体跨一个 microtask tick,node:test 这才去等所有 promise settle → **撞上本文件描述的同族悬挂 promise 死锁**(`'Promise resolution is still pending but the event loop has already resolved'`)。

- **组合性**:任意 ≤16 个测试的子集单跑/组跑全绿(EXIT 0);全 ~35 个一起跑死锁在 `tests 1, suites 0, cancelled 1`。
- `--test-force-exit` 无效:run 永不"完成",force-exit 不触发。
- 嫌疑链路:`slash-commands.ts` → `../context/payload-diagnostic` → volatile/volatile-git 的 `gitStatusCache.get()` fire-and-forget。
- **结论**:await 修复本身正确(已提交),全文件转绿与本 volatile hang 同一根因,建议合并排期一并消除(prime cache 用真实 temp git 目录)。
- **运行纪律**:`tsx --test` teardown 挂起会漏孤儿进程,反复跑会叠加假性挂起;每次跑前 `ps aux | grep '\.test\.ts' | awk '{print $2}' | xargs kill -9`。

## 本次已交付(对照参考,均已验证)

- 6 处测试修复:1 个陈旧 fixture(`aggregation.test.ts`,补 `run_tests` 证据)+ 5 个 fire-and-forget cwd 泄漏(`loop` / `loop-evidence` / `loop-intent-retrieval-router` / `loop-warmup` / `reliability-integration`,改用 `mkdtempSync` 可写 temp cwd)。
- 全 `agent/` 套:2027/2027 绿,0 失败。
- 改动均未提交,在工作区。

---

## 待办:plan-store 两处设计缺口(2026-06-07 评审,用户排期)

本轮只修了 cwd 一致性(gap 2)与非破坏性 reject(gap 3,见 commit `6703b30`)。以下两项留待排期:

### Gap 4 — slug 覆盖(`writePlan` 静默覆写)

`writePlan`(`src/plan/plan-store.ts:66-75`)无条件 `writeFile`。slug 由标题 `slugify` 而来,**两份不同计划标题相同 → 同一 slug → 后写者静默覆盖前者**,旧计划丢失无提示。

修复方向:写入前检测同名文件 —— 要么追加去重后缀(`-2`/短哈希/时间戳),要么显式报错让调用方决定。注意 approve/reject 的 `markPlanStatus` 是**有意**回写同 slug(状态标记),去重逻辑要放在"新建"路径而非状态更新路径。

### Gap 5 — `listPlans` 按 `birthtime` 排序不可靠

`readPlan`(`:92`)用 `s.birthtime` 当 `createdAt`,`listPlans`(`:115`)据此降序。`birthtime` 在部分文件系统(Linux ext3/部分 ext4、某些容器挂载)**为 0 或不支持**,导致排序退化甚至全相等。

修复方向:把创建时间写进计划内容的 frontmatter(或文件名前缀),解析它来排序,不依赖 fs 元数据;迁移期对旧文件 fallback 到 `mtime`/`birthtime`。

---

## 待办:`slash-commands.test.ts` 全文件转绿(同 volatile hang 根因)

见上方"同族新发现"小节。await 修复已落地(commit `9f0be77`),全文件 35 个测试一起跑仍被同族 fire-and-forget 死锁挡住。与本 volatile hang 合并排期,用真实 temp git 目录 prime cache 一并消除。
