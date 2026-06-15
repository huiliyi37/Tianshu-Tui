# 天枢桌面版 UX 优化 — 四层递进方案

> 基于 2026-06-15 对 `desktop/src/` 全部 30+ 源文件的完整审计，对照 TUI 能力矩阵和 ROADMAP I1-I7。

## 审计范围

已审阅文件：`App.tsx`、`main.tsx`、`ThreadView.tsx`、`Composer.tsx`、`ReviewPanel.tsx`、`ProjectSidebar.tsx`、`WorkspaceSurface.tsx`、`InboxSurface.tsx`、`AutomationsSurface.tsx`、`SettingsSurface.tsx`、`Rail.tsx`、`Markdown.tsx`、`ToolBlock.tsx`、`TaskList.tsx`、`DelegationTree.tsx`、`AutonomyControl.tsx`、`RewindOverlay.tsx`、`CommandPalette.tsx`、`ErrorBoundary.tsx`、`NewSessionDialog.tsx`、`DiffView.tsx`、`event-reducer.ts`、`store.tsx`、`queries.ts`、`use-session-events.ts`、`client.ts`、`sse.ts`、`types.ts`、`styles.css`、`tokens.css`、`lib.rs`、`tauri.conf.json`、`vite.config.ts`。

---

## 第一层：低代价立即见效（L0 — 本次交付）

| # | 问题 | 当前行为 | 目标行为 | 涉及文件 | 行号参考 |
|---|------|---------|---------|---------|---------|
| 1 | **滚动锚点缺失** | 每收到新 block 强制 `scrollIntoView`，用户上翻看历史被拉回 | 仅当用户在底部时自动滚；上翻超过一屏时显示浮动「↓」按钮 | `ThreadView.tsx` + `styles.css` | L42-46 |
| 2 | **会话搜索/过滤** | 线程列表无过滤，10+ 会话难定位 | 在项目切换下方加 `<input>` 实时过滤线程标题 | `ProjectSidebar.tsx` | L40-44 |
| 3 | **快捷键不可发现** | Cmd+K/1-4 零提示，用户不知存在 | Cmd+K 面板底部增加「快捷键」段，列出可用组合 | `CommandPalette.tsx` | — |
| 4 | **消息复制按钮** | 无文本操作入口，只能手动选中 | 消息块 hover 时右上角显示复制图标按钮 | `ThreadView.tsx` + `styles.css` | L130-150 |
| 5 | **空状态太简陋** | 纯文本 `<div class="empty">xxx</div>` | 加图标 + 引导 CTA（如空工作台直接放「新建线程」大按钮） | `ThreadView.tsx` + `ProjectSidebar.tsx` | 各处 empty |
| 6 | **窗口尺寸记忆** | 固定 1280×820，每次重启重置 | 社区插件 `tauri-plugin-window-state` 自动记忆/恢复 | `Cargo.toml` + `lib.rs` | — |

### L0 验证

```bash
cd desktop && npx tsc --noEmit && npm run build   # 前端编译通过
```

L0 改动全部在 `desktop/src/` 下，不涉及 Rust runtime 行为变更。窗口尺寸记忆（#6）仅加一个 crate dep，零 Rust 代码变更（插件 auto-init）。

---

## 第二层：中代价显著体验提升（L1）

| # | 问题 | 当前行为 | 方案 | 代价 |
|---|------|---------|------|------|
| 7 | **系统托盘** | 关闭窗口 = kill sidecar + 退出 | 关闭窗口 → 隐藏到托盘；托盘菜单：运行中会话数、快捷新建、显示窗口、退出 | 中：需 Rust 事件处理 + 托盘图标资源 |
| 8 | **原生菜单栏** | 无 macOS 菜单栏 | File（新建/设置/退出）、Edit（撤销/全选）、View（切换面板）、Help | 中：`tauri::menu` API |
| 9 | **全局快捷键** | 仅窗口内快捷键 | `tauri-plugin-global-shortcut`：Cmd+Shift+L 呼出/隐藏天枢 | 低：纯插件 |
| 10 | **代码分割** | 四个 Surface 同步打包 | `React.lazy` + `Suspense` 拆分 Settings/Automations/Inbox → 独立 chunk | 中：需确保懒加载不破坏焦点 |
| 11 | **流式渲染节流** | 每个 SSE delta → 全量 reducer + 重渲染 | `startTransition` 包裹非关键更新，或 16ms rAF 批量 | 中：需测不丢帧 |
| 12 | **虚拟滚动** | 长会话 100+ block 全量 DOM | `@tanstack/react-virtual` 仅渲染可视区消息 | 中：需处理不等高消息块 |

### L1 优先级排序

1. **#7 系统托盘** — 当前关窗 = 退出是无桌面 app 常识的行为，用户困惑度最高
2. **#9 全局快捷键** — Spotlight 式呼出是桌面效率应用标配
3. **#11 流式节流** — 流式输出时 CPU 占用高，风扇狂转
4. **#10 代码分割** — 对 UX 无直接影响，但改善首次加载

---

## 第三层：补齐 TUI 能力差距（L2）

桌面端缺少的 TUI 已有能力，按优先级：

| TUI 功能 | 后端 | 桌面端 | 补齐代价 |
|----------|------|--------|---------|
| `/goal` 长程自治任务 | `src/goal-loop.ts` 就绪 | 前端无入口 | 低：仅需 Composer slash + 调用已有 API |
| 模型切换 | `config.ts` 就绪 | hardcoded 默认 | 中：需 Settings 面板加模型选择 + API |
| 会话导出 | TUI log 导出 | 无 | 中：需前端生成 + Tauri save dialog |
| 缓存命中率 | `cache-telemetry.ts` 完整 | 无 | 中：需 SSE 事件 + ReviewPanel 新增 tab |
| Fleet/Worker detail | `delegation` 事件 | 仅有 DelegationTree | 低：扩展 DelegationTree 节点点击展开详情 |
| `/interview` 交互式需求澄清 | 后端就绪 | 无入口 | 低：仅需 Composer slash |
| 前缀缓存管理 | 后端就绪 | 无 | 中：需 Settings 面板 + API |
| 星域个性化 | `StarDomain` 体系 | 无 | 高：ROADMAP I1，需独立 plan |

---

## 第四层：架构与工程化（L3）

| # | 问题 | 方案 | 类型 |
|---|------|------|------|
| 13 | 组件测试为零 | ThreadView、Composer、ReviewPanel 加 vitest + testing-library render 测试 | 质量 |
| 14 | CSS 34KB 单文件 | 拆 styles.css → tokens / components / surfaces 三层，或迁移到 CSS modules | 架构 |
| 15 | Dock 角标 | macOS 上 `app.setBadgeCount()` 显示运行中会话数 | 体验 |
| 16 | 通知可操作 | 桌面通知点击 → 跳转到对应线程 | 体验 |
| 17 | 主题切换无动画 | CSS `transition` 在 `body` background/color 上 | 体验 |
| 18 | 不尊重 reduced-motion | pulse/spin 动画加 `@media (prefers-reduced-motion)` | 可访问性 |
| 19 | 错误恢复 | SSE 断线后仅显示 banner，不自动重连 | 韧性 |
| 20 | CI/CD | 无 GitHub Actions 自动构建桌面端 | DevOps |

---

## 架构约束（不可破）

- desktop/ 与 src/（runtime 内核）严格隔离——不做跨边界改动
- 不改变 SSE 协议 / event-reducer 数据流语义
- Rust 侧仅增插件依赖，不自己写系统调用
- 所有 CSS 使用 design tokens 变量，不写硬编码 hex

## Roadmap 中已有但未交付（不做重复规划）

- **I1** — 星域 agent 名册 + 议事会评审
- **I4** — JSON hooks 面板
- **I6** — 实时语音转写
- **I7** — 三平台打包 (DMG/Windows/Linux)
