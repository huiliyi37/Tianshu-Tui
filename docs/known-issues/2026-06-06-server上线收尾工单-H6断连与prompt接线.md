# Server 上线收尾工单 — H6 断连 + /prompt 接线

> 日期：2026-06-06
> 来源：基于实读 `src/server/prompt-route.ts` / `routes.ts` 核对，校正了 go-live gate 文档的记忆口径
> 关联：[`2026-06-06-server-subsystem-go-live-gate.md`](2026-06-06-server-subsystem-go-live-gate.md)（H6 原始定义 §3、接线缺口 §70-74）
> 范围：这是 server 子系统从「脚手架」转为「活系统」前剩余的最后两道门

## 现状校正（实读结论）

- `handlePromptSSE`（`prompt-route.ts:26-66`）**已存在**：spawn agent + SSE 流式输出，且 error / abort / 正常完成 / crash 四条路径都已 `sse.close()`。
- **H6 仍缺**：没有 `res.on('close')` 监听 —— 客户端断开后无人调 `agent.abort()`，agent 跑到底，写入死 socket。
- **接线仍缺**：`POST /prompt` 路由仍走 `buildPromptHandler` 的 `{accepted, prompt}` 回显（`prompt-route.ts:12-24`），**根本没调用 `handlePromptSSE`**，没 spawn agent。

> ⚠️ 顺序约束：WO-2 一旦把 `/prompt` 接活，H6 风险立即从「不活」变为可利用。**WO-1 必须先于或同步 WO-2。**

---

## 工单 WO-1：H6 — SSE 客户端断连 → abort agent

**目标：** 客户端断开 SSE 连接时结构性终止 agent，杜绝 token 泄漏 / 本地 DoS 放大。

**落点：** `src/server/prompt-route.ts:26-66`（`handlePromptSSE`），单文件，小改。

**实现：**
- `agent.run(...)` 之前加 `res.on('close', () => agent.abort())`。
- 加 `closed` 标志，`sse.send` 前检查（socket 已关则不再 write，防 write-after-end 抛错）。
- agent 正常结束时 `res.removeListener('close', ...)`，避免完成后误触发 abort。
- 确认 `agent.abort()` 幂等（已结束又收到 close 不应抛）。

**验收（TDD）：**
- 失败测试：模拟 `res` emit `'close'` → 断言 `agent.abort()` 被调用、后续 `sse.send` 不写。
- 既有 `prompt-route` 测试全量绿（纪律3：改 X 跑覆盖 X 的既有测试）。

**风险：** 低。单文件、纯增量。
**依赖：** 无，可立即开始。

---

## 工单 WO-2：接线 — POST /prompt 路由到 handlePromptSSE（带鉴权）

**目标：** 让 `/prompt` 真正成为 HTTP agent 入口（SSE 响应），取代现在的回显。

**落点：**
- `src/server/routes.ts`（路由表：/prompt 切换处理器）
- `src/server/index.ts`（router 支持「接管 res 做 SSE」而非返回 `{status, body}`）
- `src/main.tsx`（注入真实 `createAgent` / RuntimePool dep）

**实现：**
- `/prompt` 从 `buildPromptHandler` 切到 `handlePromptSSE(deps, res, prompt)`；router 需支持 SSE 接管模式。
- 🔒 **安全（不可省）：** `/prompt` 会 spawn agent，**必须鉴权**——风险高于 `/status`/`/abort`。复用 `routes.ts` 既有 `withAuth`，无 token → 401。**绝不能裸奔。**
- `createAgent` dep 接真实 RuntimePool（见下「待确认」）。
- 保留 prompt 非空校验（现 `buildPromptHandler:15`）。

**验收（TDD）：**
- 无 token `POST /prompt` → 401。
- 带 token + 合法 prompt → SSE 流出 `text_delta` / `turn_complete`。
- 空 prompt → 400。

**风险：** 中。改路由响应模式 + 引入 agent spawn 入口。**go-live 真正的临界开关。**
**依赖：** WO-1（先接断连护栏）。**RuntimePool 依赖已排除**（见「已核实」：无此组件，agent 工厂与鉴权均已具备）。

---

## 已核实（2026-06-06 代码核对，决定 WO-2 可排性）

- **不存在 `RuntimePool` 类**：go-live gate 文档里的 "RuntimePool" 是设想名，仓库中无此实现。WO-2 不依赖一个不存在的组件。
- **agent 工厂形状已具备**：`main.tsx:815` 已有 `createAgent: () => new AgentLoop(...)`（CLI goal loop 用），`AgentLoop` 有 `run(prompt, callbacks)` + `abort()`（`loop.ts:560`），**正好匹配** `PromptRouteDeps.createAgent` 的 `{run, abort}` 形状。可复用同款工厂喂给 server。
- **`/prompt` 鉴权已就位**：`routes.ts:42` 已是 `withAuth(buildPromptHandler(deps), apiToken)` —— WO-2 的鉴权部分**已完成**，只需换处理器时保留 `withAuth`。
- **真实缺口（WO-2 实际要做的）**：`rivet serve`（`main.tsx:750-760`）调 `createRoutes(state)` **只传 state，没传 `deps`（PromptRouteDeps）**。而 `createRoutes` 里 `if (deps)` 不成立 → **`/prompt` 路由根本没注册**（连回显都没挂上）。所以 WO-2 = ①在 serve 启动处构造带 `createAgent` 的 `PromptRouteDeps` 传进 `createRoutes`；②把 `/prompt` 处理器从 `buildPromptHandler` 换成 `handlePromptSSE`（router 支持 SSE 接管）。

> 结论：**WO-2 无外部组件依赖，可在 WO-1 之后立即排。** 不必等任何"RuntimePool"。

## 待确认

- 无。RuntimePool 疑问已澄清（不存在，不需要）。

## 安排建议

```
WO-1（立即可做，低风险）
  → 确认 RuntimePool 就绪
    → WO-2（带鉴权，go-live 临界开关）
```

完成这两单 + go-live gate §3 八项门禁（大部分已由 `2e79809` 清掉）后，server 子系统方可视为「活系统」上线。
