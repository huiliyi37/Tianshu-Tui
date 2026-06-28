# commit 卡顿根因 — typecheck spawnSync 同步阻塞事件循环

> 2026-06-28。用户报告：TUI agent 执行 commit（deliver_task）时非常卡，spinner
> `⠴ analyzing… 8m 22s` 一段时间内完全卡住不渲染。单个 commit 耗时 4m18s / 1m34s。

## 症状

- commit 后 spinner 冻结（帧不更新、时间不刷新），持续数十秒
- 单次 commit 总耗时 1–4 分钟（普通 commit 应几秒）

## 根因（主）：typecheck 用 spawnSync 同步阻塞

`deliver_task` 工具执行路径（同步）：

```
deliver_task.ts:696  runChangedFilesTypecheckMemo(cwd, change.files, ...)
  → typecheck-gate.ts:231  runChangedFilesTypecheck
    → typecheck-gate.ts:125  run(cwd)
      → lsp/client.ts:47   runTypeCheck(cwd, '*')
        → client.ts:66     spawnSync('tsc', ['--noEmit','--pretty','false'],
                                 { cwd, timeout: 120_000, maxBuffer: 10MB })
```

`spawnSync` 是**同步阻塞调用**——在 tsc 跑完或超时（120s）前，**整个 Node 事件循环冻结**：

- spinner 的 `setInterval(120ms)` ticker（app.ts:1239）无法触发
- → spinner 帧不更新、`analyzing… 8m 22s` 时间不刷新
- 本仓库规模 `tsc --noEmit` 单次实测几十秒，恰好对应卡顿窗口

**这是 spinner 冻结的直接原因。** 事件循环不转，所有定时器/IO/render 全停。

## 辅助加剧因素（拉长耗时，但不冻结 UI）

1. **deliver_task 内多处 `spawnSync('git', ...)`**（deliver-task.ts:137/148/157/626/639/648）：
   git diff/numstat/show/rev-parse，单次 timeout 5–10s，本身快，但累计。
   同样同步阻塞，每个冻结几毫秒到几秒（git 操作偶有锁等待）。
2. **worker review（routeReviewWorkflow）≤180s**（review-router.ts:91 `AUTO_REVIEW_BUDGET_MS`）：
   **异步**（`await` + AbortController，review-router.ts:168 `async function`），
   **不冻结 UI**，但拉长整体 commit 耗时。截图「提交后审查启动中（auto，≤180s）」即此。

## 为什么 worker review 不是冻结根因

`routeReviewWorkflow` 是 `async function`（review-router.ts:168），内部 `await` 子会话。
async 让出事件循环 → spinner ticker 照常 120ms 触发 → UI 不冻结，只是耗时变长。
所以 worker review 解释了「commit 总耗时 4m18s」，但**不解释**「spinner 卡死不渲染」——
后者唯一根因是 typecheck 的 `spawnSync`。

## 优化方案

### P0：typecheck 改异步 spawn（治本，消除 spinner 冻结）

把 `runTypeCheck`（lsp/client.ts:47）从 `spawnSync` 改成异步 `spawn` + Promise 包装。
签名从 `(cwd, filePath) => LspCheckResult` 变为 `async (...) => Promise<LspCheckResult>`。

**签名传播链**（4 个函数从同步变异步）：
```
lsp/client.ts:47       runTypeCheck          → Promise<LspCheckResult>
typecheck-gate.ts:29   TypecheckRunner 类型  → (cwd) => Promise<LspCheckResult>
typecheck-gate.ts:116  runChangedFilesTypecheck → async
typecheck-gate.ts:219  runChangedFilesTypecheckMemo → async
deliver-task.ts:696    调用点加 await
```

调用点仅 2 处（typecheck-gate defaultRunner + bootstrap.ts:433 runner 注入），改动面可控。
异步化后 tsc 在子进程跑，事件循环继续转，spinner 正常转动。

**注意点**：
- `runTypeCheckInProcess`（tsc 缺失时的 in-process fallback）是同步的 `ts.createProgram`，
  也需包成 async（或保留同步但标注其在小项目才走，大项目必走 subprocess）。
- memo 缓存逻辑（typecheck-gate.ts:219）不变，只是函数变 async。
- 测试里的 mock runner（`TypecheckRunner`）需相应改 async。

### P1：deliver_task 的 git spawnSync 改异步（可选，收益小）

git 操作单次 5–10s timeout 但实际多在毫秒级，冻结算不上严重。优先级低于 P0。
若做，同样 spawnSync → spawn + Promise，批量替换 deliver-task.ts 的 6 处。

### P2：worker review 耗时优化（独立议题）

≤180s 的 worker review 是设计内的交付门禁，耗时合理。若想加速可调
`AUTO_REVIEW_BUDGET_MS` 或让 auto 模式 review 异步化到后台（不阻塞 commit 返回），
但属功能性权衡，非本卡顿 bug 范畴。

## 不做的事

- 不移除 typecheck gate（它是 deliver_task 的确定性类型安全门禁，注释明确说明 tsc 跑全量
  而非 esbuild 只转译）。只改它的执行方式（同步→异步），不改它的存在与语义。
- 不动 worker review 的 budget（P2 独立议题）。

## 涉及文件

- `src/lsp/client.ts:47` — runTypeCheck 主改（spawnSync → spawn）
- `src/agent/typecheck-gate.ts` — TypecheckRunner 类型 + 两个 run 函数变 async
- `src/agent/deliver-task.ts:696` — 调用点加 await
- `src/bootstrap.ts:433` — runner 注入点签名同步
- 相关测试：typecheck-gate / deliver-task / lsp client 的 mock runner 改 async
