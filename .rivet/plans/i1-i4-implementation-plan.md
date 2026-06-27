# 实施计划：I1 星域名册/议事会 + I4 JSON hooks 面板（Plan B 修正版）

## 目标

在桌面版中交付 ROADMAP 的两个后续迭代：

- **I1**：星域 agent 名册 + 议事会评审。把现有后端星域能力（`star-domain-registry`、`council_convene`）暴露为桌面表面，并在会话卡片/标签页显示星符与 accent。
- **I4**：JSON hooks 面板。让桌面可读写 `.rivet/hooks.json`，并把 hook 执行结果写入事件流可见。

范围限定在桌面 UI 与必要的后端路由/事件；不动 agent 核心循环与 prompt frozen/cache 不变量。

---

## 方案：Plan B — `ManagedAgent.conveneCouncil` + `POST /sessions/:id/council`

不再由 UI 拼接 prompt 去触发 `council_convene`，而是在 `ManagedAgent` 上暴露一个 `conveneCouncil` 方法，由桌面直接调用。

### 为什么选 Plan B

- `ManagedAgent` 内部已持有 `AgentLoop` → `stores.refs.coordinator`。在 `buildManagedAgent`（`src/server/serve.ts:402`）中加一行 `conveneCouncil: (input) => conveneCouncilOnCoordinator(stores.refs.coordinator, stores.refs, input)` 即可，不需要动 `session-manager` 的构造函数签名。
- 并发安全：`conveneCouncil` 可以先检查 `agent.running` —— 如果 agent 正在跑 turn，直接返回 409，无需复杂排队。Council 执行期间（~10-30s 的 worker fanout），agent 正常等待，不冲突。
- 路由 `POST /sessions/:id/council` 在 `session-routes.ts` 中调用 `session.agent?.conveneCouncil?.(body)` —— 如果 agent 未就绪（idle/rehydrated），返回明确错误。
- 产物归属：council 产出的 plan markdown 写进 session 的 `ArtifactStore`（`agent.listArtifacts()` 已支持），前端通过现有 `useArtifacts` query 读取 —— 不需要新的事件类型。

---

## I1 — 星域名册 / 议事会

### 1. 后端：把星域视觉元数据带到前端

**1.1 在 `SessionRecord` 中附加当前星域视觉元数据**
- 文件：`src/server/session-manager.ts`、`desktop/src/runtime/types.ts` 的 `SessionRecord`
- 增加可选字段 `domainGlyph?: string` 和 `domainAccent?: string`。
- `starDomainRegistry` 是唯一权威源。`resolveDomainState`（`session-manager.ts:1613`）已经能通过 `starDomainRegistry.get(key)` 拿到完整 domain，包括 `uiPersona`。
- 在 `persistRecord` / `getSession` 返回 record 前，根据 `record.domain` 解析对应 persona：
  - `'auto'` → `glyph: '⚙', accent: 'primary'`
  - `'off'` → `glyph: '⊘', accent: 'dim'`
  - 具体 domain → `d.uiPersona.glyph`, `d.uiPersona.accent`
- 注意：`domain-picker-entries.ts` 已经返回 `uiPersona`，不需要再展开到顶层；SessionRecord 的 glyph/accent 由 registry 直接解析。

**1.2 补齐 `DomainEntry` 的 `uiPersona` 字段**
- 文件：`desktop/src/runtime/types.ts`
- 后端 `GET /sessions/:id/domains` 实际返回的是 `DomainPickerEntry`（含 `uiPersona?: { separator, accent, glyph }`）。
- 在桌面端 `DomainEntry` 类型中显式声明：

```ts
uiPersona?: {
  separator: 'thin' | 'thick' | 'dots'
  accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
  glyph: string
}
```

### 2. 后端：`ManagedAgent.conveneCouncil`

**2.1 `ManagedAgent` 接口扩展**
- 文件：`src/server/session-manager.ts`
- 在 `ManagedAgent` 接口新增：

```ts
conveneCouncil?(input: {
  artifactId: string
  objective?: string
  seats?: { authority: string; charter?: string }[]
  rounds?: number
}): Promise<{ planMarkdown: string; artifactId: string }>
```

- 说明：前端只传 `artifactId` 和可选的 `objective`/`seats`/`rounds`；后端从 `agent.artifactStore.readRaw(artifactId)` 读 raw，解析内嵌的 `\`\`\`council-plan-json` 块得到 `UnifiedPlan`，再转成 `PlanItem[]` 作为 `draftItems`。这样前端不需要了解 unified plan schema。

**2.2 `buildManagedAgent` 实现 `conveneCouncil`**
- 文件：`src/server/serve.ts`
- 新增辅助函数 `conveneCouncilOnCoordinator(agent, coordinator, input)`：
  - 检查 `agent.running`；如正在运行则 throw 409-like 错误，由路由包装为 HTTP 409。
  - 读取 artifact raw；用正则或 `extractJsonCandidates` 提取 `council-plan-json` 块，parse 为 `UnifiedPlan`。
  - 将 `UnifiedPlan.tasks` 映射为 `PlanItem[]`（`id`, `title`, `objective` 作为 `detail`, `files`）。
  - 调用 `runCouncil` / `runCouncilDebate`（`src/agent/council/council-orchestrator.ts`）。
  - 产物 markdown 通过 `agent.artifactStore.save(...)` 写入 artifact，返回 `{ planMarkdown, artifactId }`。
- 在 `buildManagedAgent` 返回对象中加入 `conveneCouncil`。

**2.3 REST 路由 `POST /sessions/:id/council`**
- 文件：`src/server/session-routes.ts`
- 新增路由，body 校验：
  - `artifactId`: string（必填）
  - `objective?`: string（可选，默认从 artifact 内容或文件名推断）
  - `seats?`: array
  - `rounds?`: number (1-2)
- 调用 `session.agent?.conveneCouncil?.(body)`，处理三种状态：
  - agent 不存在 → 404
  - agent 正在运行 → 409
  - artifact 解析失败 → 400
  - 成功 → 200 `{ planMarkdown, artifactId }`

### 3. 后端测试

- 文件：`src/server/__tests__/council-route.test.ts`（新建）
- 用 `FakeAgent` + mock coordinator 验证：
  - 200：正常 conveneCouncil 返回 plan
  - 409：agent 正在运行
  - 404/503：agent 为 null 或未暴露 conveneCouncil
  - 400：artifact 无法解析为 council plan

### 4. 前端：星符 badge

**4.1 会话列表（ProjectSidebar）**
- 文件：`desktop/src/surfaces/ProjectSidebar.tsx`
- 在 `thread-row` 标题前渲染 `<span className="domain-glyph domain-accent-{s.domainAccent}">{s.domainGlyph}</span>`。

**4.2 标签页（ThreadTabs）**
- 文件：`desktop/src/components/ThreadTabs.tsx`
- 在 tab 标题前渲染星符；从 `session.domainGlyph` / `session.domainAccent` 读取。

**4.3 ThreadView 头部**
- 文件：`desktop/src/surfaces/ThreadView.tsx`
- 把现有的 `thread-glyph` 和 `domain-*` 类名绑定到 `session.domain` / `session.domainGlyph` / `session.domainAccent`，而非硬编码。

### 5. 前端：新增 `useDomains` query

- 文件：`desktop/src/state/queries.ts`
- 后端 `GET /sessions/:id/domains` 和客户端 `listDomains` 已存在，但缺少 React Query hook。
- 新增 `useDomains(sessionId: string | null)`，返回 `DomainEntry[]`。

### 6. 前端：新增 `council` 表面

**6.1 Surface 注册**
- `desktop/src/state/store.tsx`：`Surface` 增加 `'council'`。
- `desktop/src/components/Rail.tsx`：`ICONS` 和 `order` 增加 `council`（可用 `Users` / `Scale` / `Sparkles`）。
- `desktop/src/surfaces/ProjectSidebar.tsx`：`SURFACE_ORDER`、`SURFACE_LABEL`、`NAV_ICONS` 增加 `council`。
- `desktop/src/App.tsx`：lazy import `CouncilSurface`，switch case 增加 `council`。
- `desktop/src/locales/en/nav.json` / `zh-CN/nav.json`：增加 `council` 标签。

**6.2 `CouncilSurface.tsx`**
- 路径：`desktop/src/surfaces/CouncilSurface.tsx`
- 使用 `useUiState` 取 `activeSessionId`；用 `useDomains(activeSessionId)` 和 `useArtifacts(activeSessionId)`。
- 上半部分：星域名册卡片网格，每张卡片显示 glyph、name、motto、meta、essence、decisionStyle、keywords；当前会话选中的卡片高亮；点击卡片调用 `setDomain` mutation。
- 下半部分：议事会发起区。
  - 列出当前会话的 plan/task-list artifacts；用户选择一条。
  - 如果 `session.status === 'running'` 或 agent 未就绪，显示「当前会话正在运行 / 未就绪，请稍后再试」，禁用发起按钮。
  - 点击「召集议事会」，调用新 API `conveneCouncil(sessionId, { artifactId })`。
  - 成功后 toast 提示，并自动刷新 `useArtifacts`。
- 底部：council 结果区。如果该会话最新产出了 `council-plan` / `plan` 类 artifact，显示其摘要和「查看详情」按钮。

---

## I4 — JSON hooks 面板

### 1. 后端：hooks 路由

**1.1 `RuntimeSessionManager` 增加读写方法**
- 文件：`src/server/session-manager.ts`
- 新增：
  - `getHooks(id: string): HooksConfig | undefined`
  - `setHooks(id: string, config: HooksConfig): boolean`
- 实现：用 `node:fs/promises` 读写 `join(session.record.cwd, '.rivet', 'hooks.json')`；`setHooks` 前校验每个 entry 的 `event` 合法、`script` 为字符串、可选 `timeoutMs` 为正数。

**1.2 REST 路由**
- 文件：`src/server/session-routes.ts`
- 新增：
  - `GET /sessions/:id/hooks` → `manager.getHooks(id)`
  - `POST /sessions/:id/hooks` → body `{ hooks: HookEntry[] }`，调用 `manager.setHooks(id, config)`

### 2. 后端：hook 执行结果进入事件流

**2.1 `AgentCallbacks` 增加回调**
- 文件：`src/agent/loop-types.ts`
- 增加 `onHookResult?: (results: Array<{ script: string; ok: boolean; output: string }>) => void`

**2.2 桥接层把结果传出来，并补齐 `onError`**
- 文件：`src/agent/hooks/user-hooks-bridge.ts`
- `UserHooksBridgeDeps` 增加 `onHookResult?: ...`。
- 当前只桥接了 `preTurn` / `postTurn` / `postTool` / `postSession`。`user-hooks-runner.ts` 还定义了 `onError`。
- 扩展 `bridgeHook` 或新增一个 `postError` RuntimeHook：在 `onError` 阶段调用 `runHooksForEvent({ event: 'onError', error })` 并把结果传给 `deps.onHookResult`。
- 在每个 `bridgeHook.run` 中把 `runHooksForEvent` 返回值传给 `deps.onHookResult?.(results)`。

**2.3 `loop-factory.ts` 注入 deps 时传入 callback**
- 文件：`src/agent/loop-factory.ts`
- `userHooksBridge` deps 增加 `onHookResult: (results) => callbacks.onHookResult?.(results)`。

**2.4 `session-manager` 把结果 append 到事件流**
- 文件：`src/server/session-manager.ts`
- `buildCallbacks` 中实现 `onHookResult`：调用 `this.append(session, 'hook_result', { results })`。
- `SessionEventType` 增加 `'hook_result'`。
- **高频率控制**：`hook_result` 每次 hook 触发都产生。为避免事件环形缓冲（默认 5000）被刷掉用户消息，考虑：
  - 仅保留最近 50 条 `hook_result`，或
  - 在事件 reducer / 持久化层对 `hook_result` 做压缩（同脚本同事件去重）。
  - 先实现「保留最近 50 条」 simplest，后续可视情况优化。

### 3. 前端：hooks 数据层

**3.1 client.ts**
- 文件：`desktop/src/runtime/client.ts`
- 新增 `getHooks(id: string): Promise<HooksConfig>` 和 `saveHooks(id: string, config: HooksConfig): Promise<{ ok: boolean }>`。

**3.2 queries.ts**
- 文件：`desktop/src/state/queries.ts`
- 新增 query key `hooks`。
- `useHooks(sessionId: string | null)` 和 `useSaveHooks()` mutation。

### 4. 前端：新增 `hooks` 表面

**4.1 Surface 注册**
- 同 I1 的 surface 注册流程，新增 `'hooks'`（图标可用 `Plug` / `Terminal`）。
- 在 `SettingsSurface` 的 integrations 分类里也可加一个入口，方便用户习惯。

**4.2 `HooksSurface.tsx`**
- 路径：`desktop/src/surfaces/HooksSurface.tsx`
- 使用 `useHooks(activeSessionId)` 读取配置，`useSaveHooks()` 写入。
- UI：
  - 列表：每行显示 event 下拉（preTurn / postTurn / postTool / postSession / onError）、script 路径输入、timeout 数字输入、启用/禁用开关、删除按钮。
  - 「新增 hook」按钮。
  - 「保存」按钮，保存后 toast 提示。
  - 底部事件流：通过 `useSessionEvents(activeSessionId)`（`desktop/src/state/use-session-events.ts` 已存在）过滤 `type === 'hook_result'`，显示脚本输出/失败信息。

---

## 验证计划

| 验证项 | 方式 |
|--------|------|
| 后端类型检查 | `npm run typecheck`（touched 文件无错误） |
| council 路由测试 | 新增 `src/server/__tests__/council-route.test.ts`：200/409/agent-null/artifact-parse |
| hooks 路由测试 | 新增 `src/server/__tests__/hooks-routes.test.ts`：GET/POST hooks、hook_result 事件写入 |
| 前端类型/构建 | `cd desktop && npm run build`（tsc + vite） |
| 前端 UI 目测 | `tauri dev` 或浏览器 dev：新 surface 导航、星符 badge、hooks 编辑保存、council 触发 |

---

## 关键文件清单

### I1
- `src/server/session-manager.ts` — `ManagedAgent` 接口、`SessionRecord` glyph/accent、domain 解析
- `src/server/serve.ts` — `buildManagedAgent` 增加 `conveneCouncil`
- `src/server/session-routes.ts` — `POST /sessions/:id/council`
- `src/server/__tests__/council-route.test.ts`（新建）
- `desktop/src/runtime/types.ts` — `SessionRecord.domainGlyph/accent`、`DomainEntry.uiPersona`
- `desktop/src/surfaces/ProjectSidebar.tsx`
- `desktop/src/components/ThreadTabs.tsx`
- `desktop/src/surfaces/ThreadView.tsx`
- `desktop/src/surfaces/CouncilSurface.tsx`（新建）
- `desktop/src/runtime/client.ts` — `conveneCouncil`、`listDomains` 已存在
- `desktop/src/state/queries.ts` — `useDomains`、`useConveneCouncil`
- `desktop/src/state/store.tsx`、`desktop/src/components/Rail.tsx`、`desktop/src/surfaces/ProjectSidebar.tsx`、`desktop/src/App.tsx`
- `desktop/src/locales/en/nav.json`、`zh-CN/nav.json`

### I4
- `src/hooks/user-hooks-runner.ts`（类型已存在）
- `src/agent/loop-types.ts` — `onHookResult`
- `src/agent/hooks/user-hooks-bridge.ts` — 桥接结果 + 补齐 onError
- `src/agent/loop-factory.ts` — 注入 callback
- `src/server/session-manager.ts` — `getHooks/setHooks`、`hook_result` append
- `src/server/session-routes.ts` — hooks 路由
- `src/server/__tests__/hooks-routes.test.ts`（新建）
- `desktop/src/runtime/client.ts` — hooks client
- `desktop/src/state/queries.ts` — `useHooks/useSaveHooks`
- `desktop/src/surfaces/HooksSurface.tsx`（新建）
- `desktop/src/state/event-reducer.ts` — `hook_result` fold
- surface 注册相关文件（同 I1 列表）

---

## 交付顺序

1. I1 后端：`SessionRecord` 增加 `domainGlyph` / `domainAccent`，在 `persistRecord` / `getSession` 返回前从 `starDomainRegistry` 解析；补齐 `DomainEntry.uiPersona`。
2. I1 前端 badge（ProjectSidebar / ThreadTabs / ThreadView）。
3. I1 前端：`useDomains` query。
4. I1 后端：`ManagedAgent.conveneCouncil` + `POST /sessions/:id/council` 路由 + 测试。
5. I1 前端：`CouncilSurface` 调用新路由 + surface 注册。
6. I4 后端：hooks 路由 + `hook_result` 事件 + `onError` 桥接 + 测试。
7. I4 前端：`HooksSurface` + surface 注册。
8. 端到端验证、ROADMAP 更新、changelog。

---

## 执行状态

- [x] I1 后端：`SessionRecord.domainGlyph/accent`、`DomainEntry.uiPersona`、`AgentLoop.isRunning()`、`ManagedAgent.conveneCouncil`、`POST /sessions/:id/council`。
- [x] I1 前端：星符徽章、`useDomains`、`CouncilSurface` + surface 注册。
- [x] I4 后端：`GET/PUT /sessions/:id/hooks`、`hook_result` 事件、`onError` 桥接、保留最近 50 条。
- [x] I4 前端：`HooksSurface`、`useHooks`/`useSetHooks`、event-reducer 收集 `hook_result`、surface 注册。
- [x] 验证：后端 `council-route/hooks-route/hook-result-events/user-hooks-bridge` 测试绿；桌面 `tsc --noEmit`、`npm test`（含 event-reducer/client 新增用例）绿；`npm run check:i18n` 绿。

### 与计划的关键偏差
- I4 hook 结果没有走 `AgentCallbacks.onHookResult`，而是通过 `AgentConfig.emitHookResult` 直接透传给 `RuntimeSessionManager.emitHookResult`，减少了回调层耦合。
- I4 hooks 写入路由最终使用 `PUT /sessions/:id/hooks`（幂等全量替换），而非 `POST`。
- I4 `onError` 桥接挂在 `RuntimeHookPipeline` 的 `onError` 选项上，由 `createRuntimeHooksPipeline` 统一处理 runtime hook 抛错。
