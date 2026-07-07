# 2026-06-27 — I1 星域名册/议事会 + I4 JSON hooks 面板

## 新增

- **I1 星域名册 / 议事会**
  - 后端：`SessionRecord` 现在携带 `domainGlyph`/`domainAccent`，会话卡片/标签页可显示当前星符。
  - 后端：`ManagedAgent.conveneCouncil` + `POST /sessions/:id/council`，直接评审包含 `council-plan-json` 的 plan artifact。
  - 前端：`CouncilSurface` 星域名册卡片 + 议事会发起；`ProjectSidebar`/`ThreadTabs`/`ThreadView` 星符徽章。
  - 新增 `useDomains` / `useConveneCouncil`。

- **I4 JSON hooks 面板**
  - 后端：`GET /sessions/:id/hooks` + `PUT /sessions/:id/hooks` 读写 `.rivet/hooks.json`。
  - 后端：`user-hooks-bridge.ts` 把 `preTurn/postTurn/postTool/postSession` 执行结果作为 `hook_result` 事件推进会话事件流；补齐 `onError` 桥接。
  - 后端：`RuntimeSessionManager.emitHookResult` 追加事件并仅保留最近 50 条，避免刷掉用户消息。
  - 前端：`HooksSurface` 编辑 hook 条目并展示最近 `hook_result`；`event-reducer.ts` 收集 `hook_result`。
  - 新增 `useHooks` / `useSetHooks`、桌面 `getHooks`/`setHooks` client。

## 验证

- 后端测试：`src/server/__tests__/council-route.test.ts`、`hooks-route.test.ts`、`hook-result-events.test.ts`、`src/agent/__tests__/user-hooks-bridge.test.ts` 全部通过。
- 桌面测试：`npm test` 139 条通过（含 event-reducer / client 新增用例）。
- 桌面类型检查：`npx tsc --noEmit` 通过。
- i18n 键对齐：`npm run check:i18n` 通过。
