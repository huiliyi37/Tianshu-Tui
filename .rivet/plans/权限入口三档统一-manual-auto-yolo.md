# 权限入口三档统一：Manual / Auto / YOLO

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现。

**目标：** 将分散在 `/yes`、`/auto`、`/autonomy`、`/permission` 四个命令里的 agent 自主程度控制，收敛为一个 Kimi 风格的交互式选择器（三档 + 可选检查点子设置）。

**现状问题：**

- `/yes` — 只切换 yolo ↔ auto-safe，不涉及精细控制
- `/auto` — toggle auto-safe，功能与 `/yes off` 重叠
- `/autonomy` — cruise/unleashed + 检查点间隔，与 yolo 概念重叠
- `/permission mode` — 四种模式藏在子命令里，没有交互式选择器
- `autonomyBrake` 字段（cruise/unleashed）是"approval mode 内部的刹车"，增加了用户心智负担

---

## 架构

```mermaid
flowchart TD
    U(用户输入 /permission 无参) --> R[[slash-commands.ts: handler]]
    R --> S{当前模式?}
    S -->|manual| M{{展示 Manual 卡片}}
    S -->|auto-safe| A{{展示 Auto 卡片 + 可配检查点}}
    S -->|dangerously-skip| Y{{展示 YOLO 卡片}}
    R -.上下键选择.-> SEL[[Kimi 风格选择器]]
    SEL --> C{用户回车确认}
    C -->|Manual| SM[[setApprovalMode: manual]]
    C -->|Auto| SA[[setApprovalMode: auto-safe / 可配 checkpointEveryTurns]]
    C -->|YOLO| SY[[setApprovalMode: dangerously-skip-permissions / 需二次 confirm]]
    SM --> PERSIST[(~/.rivet/config.json)]
    SA --> PERSIST
    SY --> PERSIST
    SY -.无刹车无播报.-> RUN[[run() 全程静默执行]]
    SA -.checkpointEveryTurns > 0.-> PAUSE{{每 N 轮暂停 + 进度摘要}}
```

**三档映射：**

| 档位 | approvalMode | 检查点 | 说明 |
|------|-------------|--------|------|
| Manual | `manual` | 无 | 每个需审批工具都弹确认 |
| Auto | `auto-safe` | 可选 `checkpointEveryTurns`（0=关） | 低风险自动，高风险弹 |
| YOLO | `dangerously-skip-permissions` | 无（不读 checkpointEveryTurns） | 全自动无打扰 |

---

## 任务 1：移除 `autonomyBrake` 字段 + 精简 schema

**调研背书：**

| 符号 | 引用位置 | 处理 |
|------|---------|------|
| `autonomyBrake` (schema) | `src/config/schema.ts:224` | 删除 |
| `autonomyBrake` (default) | `src/config/default.ts:124` | 删除 |
| `get/setAutonomyConfig` | `src/config/manager.ts:234-274` | 重命名为 get/setCheckpointConfig，只留 checkpointEveryTurns |
| `getAutonomyBrake` dep | `src/agent/loop-factory.ts:629` | 删除 |
| `getAutonomyBrake` 调用 | `src/agent/turn-orchestrator.ts:362` | 删除 |
| `AutonomyBrakeMode` 类型 | `src/config/manager.ts:234` | 删除 |
| `setAutonomyBrake` | `src/agent/loop.ts` | 删除方法 |
| AgentLoopConfig.autonomyBrake | `src/agent/loop-types.ts` | 删除字段 |
| AgentCallbacks.setAutonomyBrake | `src/agent/loop-types.ts` | 删除回调 |
| config-routes GET/PUT /config/autonomy | `src/server/config-routes.ts:234-248` | 改为 checkpoint-only |
| aut config UI | `desktop/src/surfaces/SettingsSurface.tsx:544,591-600` | 移除 brake 分段 |

- [ ] 修改 `src/config/schema.ts:216-226` — 删除 autonomyBrake 字段；checkpointEveryTurns 注释改为 "Auto 模式下每 N 轮暂停（0 = 关，默认关）"
- [ ] 修改 `src/config/default.ts:124` — 删除 autonomyBrake 行
- [ ] 修改 `src/config/manager.ts:234-274` — 删除 AutonomyBrakeMode 类型；AutonomyConfigSnapshot 只保留 checkpointEveryTurns；getAutonomyConfig → getCheckpointConfig；setAutonomyConfig → setCheckpointConfig（移除 autonomyBrake 校验分支）
- [ ] 修改 `src/agent/loop-types.ts` — AgentLoopConfig 移除 autonomyBrake；AgentCallbacks 移除 setAutonomyBrake；AutonomyCheckpointInfo 保留（checkpoint 暂停时仍然用到 paused:true）
- [ ] 修改 `src/agent/loop.ts` — 删除 setAutonomyBrake 方法和对应导入
- [ ] 修改 `src/agent/loop-factory.ts:625-629` — getCheckpointEveryTurns 改为仅检查 `self.config.approvalMode === 'auto-safe'`（不是 dangerously-skip-permissions 即停）；删除 getAutonomyBrake；buildProgressDigest 保留不动
- [ ] 修改 `src/agent/turn-orchestrator.ts:354-370` — 简化刹车分支：`if (checkpointEvery > 0 && turn > 0 && turn >= checkpointEvery) { ... emitStop + onAutonomyCheckpoint({ paused: true }) + break }`（不再检查 autonomyBrake）

---

## 任务 2：TUI 端 `/permission` 改造为三档交互选择器

- [ ] 新增 `src/tui/components/permission-selector.tsx` — Ink 组件，渲染三档选择器（方向键导航 + 回车确认），Manual/Auto/YOLO 各带描述；YOLO 需二次 confirm 屏（列出风险 + 要求再次回车）
- [ ] 修改 `src/tui/slash-commands.ts:1231` — `/permission` 无参时渲染 PermissionSelectorComponent（通过 pushStatic 或直接 setComponent）；有子命令时保留原 allow/deny/bash/remove/reset/test 逻辑
- [ ] 删除 `src/tui/slash-commands.ts:1206-1228` — `/yes` 命令
- [ ] 删除 `src/tui/slash-commands.ts:1192-1204` — `/auto` 命令
- [ ] 删除 `src/tui/slash-commands.ts:1444-1515` — `/autonomy` 命令
- [ ] 修改 `src/tui/engine/app.ts:322` — `_approvalMode` 默认值从 `auto-safe` 改为 `manual`（新用户首次启动默认 Manual）

---

## 任务 3：Desktop 端设置面板改造

- [ ] 修改 `desktop/src/surfaces/SettingsSurface.tsx:542-678` — CheckpointSection 重写为 PermissionSection：三档单选按钮（Manual/Auto/YOLO），Auto 下显示 checkpoint 间隔下拉 + 自定义输入（复用现有 interval 控件）；YOLO 点击后弹 AlertDialog 风险确认
- [ ] 更新 `desktop/src/runtime/client.ts` & `desktop/src/runtime/types.ts` — AutonomyConfig 类型只保留 checkpointEveryTurns
- [ ] 修改 `desktop/src/surfaces/ThreadView.tsx:1316-1323` — 删除 unleashed 非阻塞播报渲染分支（paused:false 路径，已死码）
- [ ] 修改 `desktop/src/state/event-reducer.ts:456-471` — 删除 unleashed 非阻塞播报路径（paused:false 分支）

---

## 任务 4：Server 层同步

- [ ] 修改 `src/server/config-routes.ts:234-248` — GET/PUT /config/autonomy 路由改为只读写 checkpointEveryTurns
- [ ] 修改 `src/server/session-manager.ts:2206-2209` — onAutonomyCheckpoint 回调注释更新（移除 unleashed 引用）

---

## 任务 5：测试全面同步

- [ ] 修改 `src/config/__tests__/layered-config.test.ts` — 移除 autonomyBrake drift guard 测试；迁移测试预期 25→0 已在上次提交完成，本次确认通过
- [ ] 修改 `src/agent/__tests__/autonomy-checkpoint.test.ts` — 移除 unleashed 测试（已在上次提交完成）；移除 setAutonomyBrake 测试；cruise 测试改为 Auto 模式下的 checkpoint 测试
- [ ] 修改 `src/__tests__/create-agent-config.test.ts` — 移除 autonomyBrake 断言
- [ ] 修改 `src/tui/__tests__/app-autonomy-visibility.test.ts` — 更新为新的 permission selector 行为

**验证命令（每个任务完成后执行）：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/config/__tests__/layered-config.test.ts
npm exec -- tsx --test src/agent/__tests__/autonomy-checkpoint.test.ts
npm exec -- tsx --test src/__tests__/create-agent-config.test.ts
npm exec -- tsx --test src/tui/__tests__/app-autonomy-visibility.test.ts
```

---

## 设计决策对比

| 维度 | 当前方案 | 新方案 |
|------|---------|--------|
| 权限入口命令数 | 4 (/yes /auto /autonomy /permission) | 1 (/permission) |
| 模式数量 | 4 approval × 2 brake = 8 种心智组合 | 3 档 |
| YOLO 行为 | 每 25 轮播报（不暂停但打扰） | 完全静默 |
| 默认模式 | auto-safe（中等风险自动过） | manual（首次启动需主动选） |
| 检查点归属 | cruise/unleashed 各自的语义 | Auto 专属可选子设置 |
