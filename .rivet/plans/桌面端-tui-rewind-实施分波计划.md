# 桌面端+TUI Rewind 实施分波计划

## 实施分波计划

基于已审批的完整设计（`.rivet/plans/桌面端-rewind-回滚功能设计.md`），拆分为 3 个独立可交付的 Wave。

### Wave 1: 后端共享层（桌面端 + TUI 共同依赖）

**目标**：ManagedAgent 接口扩展 + RuntimeSessionManager rewind 方法 + 2 条新路由

| 任务 | 文件 | 行为变更 |
|------|------|---------|
| ManagedAgent 加 getMessages/replaceMessages | `session-manager.ts` | 接口扩展 |
| serve.ts 适配器实现这两个方法 | `serve.ts` | agent.session 透传 |
| RuntimeSessionManager.listRewindPoints | `session-manager.ts` | 新方法 |
| RuntimeSessionManager.rewind | `session-manager.ts` | 新方法 + rewind 事件 |
| GET /sessions/:id/rewind-points 路由 | `session-routes.ts` | 新路由 |
| POST /sessions/:id/rewind 路由 | `session-routes.ts` | 新路由 |
| 后端测试 6 条 | `__tests__/rewind.test.ts` | 新建 |

**过门**：rewind 测试全绿 + tsc 绿 + 桌面端原有测试不回归

### Wave 2: TUI 接线（双击 ESC + 数据接通 + Enter 截断）

**目标**：T9 engine 的 rewind overlay 从骨架变成可用

| 任务 | 文件 | 当前行为 → 改后行为 |
|------|------|---------|
| 双击 ESC 检测 | `engine/app.ts` ESC 分支 | idle 空输入单次 ESC 无操作 → 300ms 内第二次 ESC 打开 rewind overlay |
| rewindEntries 数据接线 | `engine/app.ts` registerOverlays 调用处 | 从未传入 → 从 SessionContext 提取 user messages |
| rewindExec 回调 | `engine/app.ts` registerOverlays 签名 + Enter 处理 | Enter 只 setInput → 调 rewindExec 截断消息+历史+setInput |
| TUI 测试 4 条 | `engine/__tests__/` | 双击ESC/单次ESC不触发/Enter截断/间隔超时 |

**过门**：双击 ESC 实际打开 overlay + Enter 选中后 `session.getMessages()` 长度减少 + tsc 绿

### Wave 3: 桌面端新建

**目标**：桌面端从零获得 rewind UI

| 任务 | 文件 |
|------|------|
| RewindOverlay 组件 | `desktop/src/components/RewindOverlay.tsx` |
| 双击 ESC hook | `desktop/src/hooks/use-double-esc.ts` |
| event-reducer 处理 rewind 事件 | `desktop/src/state/event-reducer.ts` |
| runtime client 扩展 | `desktop/src/runtime/client.ts` |
| queries rewind mutation | `desktop/src/state/queries.ts` |
| ThreadView 接入 | `desktop/src/surfaces/ThreadView.tsx` |

**过门**：desktop typecheck + build 绿 + 双击 ESC 打开 overlay + 选中后消息截断
