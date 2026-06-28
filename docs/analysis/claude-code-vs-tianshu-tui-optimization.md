# Claude Code vs 天枢：终端工作流与 UI 交互对比分析

> 分析目标：Claude Code（`/Users/banxia/app/opencode/claude-code-haha`）的终端工作流与 UI 交互设计，识别天枢（`/Users/banxia/app/deepseek-tui/opencode-tui`）可优化的层级。
> 分析时间：2026-06-28

---

## 1. 两者架构速览

### 1.1 Claude Code

| 层级 | 实现 |
|------|------|
| UI 框架 | React 19 + 定制 Ink 6（`src/ink/` 为自维护版本） |
| 主屏幕 | `src/screens/REPL.tsx`（约 5,000 行） |
| 输入框 | `src/components/PromptInput/PromptInput.tsx`（约 2,300 行） |
| 状态管理 | React Context + `AppStateStore` + `useSyncExternalStore` |
| 消息渲染 | `Messages.tsx` + `VirtualMessageList.tsx`，带高度缓存、sticky prompt、搜索索引 |
| 权限确认 | `PermissionRequest.tsx` 按工具类型分发专用组件 |
| 命令队列 | `messageQueueManager.ts`，支持 `now/next/later` 优先级 |
| 执行流 | `processUserInput` → `query.ts` → `StreamingToolExecutor.ts` |

### 1.2 天枢 / Rivet

| 层级 | 实现 |
|------|------|
| UI 框架 | T9 自定义 ANSI 引擎，已替换原 React/Ink 栈 |
| 主应用 | `src/tui/engine/app.ts`（`TuiApp`，约 2,500 行） |
| 底部动态区 | `src/tui/engine/live-engine.ts`（增量重绘，cursor-resident） |
| 滚动历史 | `src/tui/engine/commit-engine.ts`（append-only，环状缓冲 1,000 行） |
| 状态管理 | 纯 class properties + `WriteBatcher` 事件驱动渲染 |
| 流式渲染 | `BlockStreamWriter` → `StreamRenderer` → `LiveEngine` |
| 工具状态 | `ToolGroupController`（可折叠组、累加器、截断缓存） |
| 审批状态 | `ApprovalIntentController`（极简状态容器） |
| 输入 | `InputLine`（vim、历史、Tab 补全、bracketed paste） |
| 命令路由 | `SlashRouter` 桥接 `slash-commands.ts` |

---

## 2. 分层对比与可优化点

### 2.1 渲染引擎层：天枢已领先，CC 有可借鉴点

| 维度 | Claude Code | 天枢 T9 | 结论 |
|---|---|---|---|
| 渲染方式 | React reconciler + Yoga 布局，全屏 diff | cursor-resident live region，增量重绘，不触发全屏清屏 | T9 更轻量 |
| 长会话 | `VirtualMessageList` 虚拟化 + 高度缓存 | 1,000 行环状 scrollback 截断 | 各有取舍 |
| resize | Ink 重排 | `reconcileWidth` 按当前宽度重算 display rows | T9 更稳 |

**优化建议**：
- T9 的 `CommitEngine` 直接丢掉超过 1,000 行的旧内容，用户无法回顾早期对话。可引入**持久化 scrollback 归档**：将超出行数写入 `~/.rivet/sessions/<slug>/scrollback.log` 或会话 JSONL，配合 `/scroll`（pager overlay）实现完整历史检索，而不是简单截断。
- 参考 CC 的 `VirtualMessageList` 实现一个可选的**全屏 transcript overlay**，支持搜索高亮、跳转、sticky prompt，弥补 T9 主屏无虚拟化的短板。

### 2.2 输入与命令层：CC 更丰富，天枢可补齐

| 维度 | Claude Code | 天枢 |
|---|---|---|
| 输入框 | PromptInput 2,300 行：粘贴引用、语音、@IDE、typeahead、suggestion、fast mode | InputLine 635 行：vim、历史、Tab、@文件补全 |
| 命令队列 | `messageQueueManager` 优先级队列 + `useSyncExternalStore` | `SteerBuffer` 简单字符串队列 |
| 即时命令 | `immediate: true` 的 local-jsx 命令可覆盖全屏对话框 | `SlashRouter` 特殊 case 多，部分仍走共享 handler |
| 粘贴 | 支持 `[Pasted text #N]` 引用与展开 | bracketed paste 支持，但无结构化引用 |

**优化建议**：
1. **升级 `SteerBuffer` 为优先级命令队列**：当前只存字符串，draining 时统一包装成 `[User guidance]`。参考 `messageQueueManager.ts` 的 `now/next/later` 优先级，把用户 steer、任务通知、孤儿审批请求分开调度，避免通知饿死或审批被覆盖。
2. **统一命令框架**：`SlashRouter` 目前对 `/starmap`、`/cockpit`、`/vim`、`/auto` 等做大量特殊判断。可抽象为命令元数据：`{ name, immediate, handler, overlay?, needsAgent? }`，减少 `app.ts` 与 `SlashRouter` 的耦合。
3. **输入框增强**：增加粘贴文本引用机制（类似 CC 的 `pastedContents`），让用户能看到粘贴内容的摘要；增加 inline suggestion / typeahead，especially for `/` 命令和 `@` 文件。

### 2.3 审批与权限层：天枢需要工具专用渲染

Claude Code：
- `PermissionRequest.tsx` 按工具类型分发：`BashPermissionRequest`、`FileEditPermissionRequest`、`FileWritePermissionRequest`、`FilesystemPermissionRequest` 等。
- 每个组件做工具专属 UI：bash 展示命令、文件编辑展示 diff、文件写入展示路径与行数。

天枢：
- `ApprovalIntentController` 仅 26 行，只存 pending 状态。
- 预览逻辑散落在 `TuiApp.formatApprovalPreview`（约 40 行），通用且简单。

**优化建议**：
- 引入 **tool-specific approval renderer**：`src/tui/format/approval/` 下为高频工具（bash、write_file、edit_file、delegate_task）提供专用卡片。
  - bash：展示完整命令 + 危险命令检测标记
  - write/edit：展示 diff 预览（复用 `formatDiff`）
  - delegate：展示 objective / task list
- 解耦 `formatApprovalPreview` 出 `app.ts`，减少主类体积。

### 2.4 工具执行可视化层：天枢已较好，可再细化

天枢：
- `formatToolCard` 已实现 Claude Code 风格 `● Verb(arg) (elapsed)` + `⎿` body。
- `ToolGroupController` 管理 pending/accumulator/collapsed group。
- 支持 `Ctrl+O` 展开截断工具。

Claude Code：
- `ToolUseLoader` 只是一个闪烁圆点，相对简单。
- 但 `Messages.tsx` 里有大量工具分组、折叠、去重逻辑（`collapseReadSearchGroups`、`collapseBackgroundBashNotifications` 等）。

**优化建议**：
- 把 `Messages.tsx` 中的**工具结果去重/折叠启发式**迁移到天枢：
  - 连续 read/grep 结果合并为 "Read 5 files"
  - 后台 bash 通知合并
  - hook summary 折叠
- 当前 `CollapsedReadSearchBuffer` 已有基础，可扩展为更通用的 `MessageGrouper`。

### 2.5 状态管理层：天枢更优，无需大改

Claude Code 依赖 React 状态树，长会话下 fiber 树庞大（CC 自己注释提到 2,000 条消息时 ~500 MB RSS、GC 死亡螺旋）。天枢用纯 class fields + `WriteBatcher` 事件驱动，天然避免了这个问题。

**优化建议**：保持当前设计，不要回退到 React 全局状态。只需把 `TuiApp` 进一步拆分：
- `app.ts` 目前 2,500+ 行，注释已提到要拆出 `InputController`、`StreamRenderController`、`MetricsGlanceController` 等。继续推进拆分即可。

### 2.6 消息历史与 transcript 层：天枢明显薄弱

Claude Code：
- 全屏 transcript 模式：虚拟列表、搜索 `/` + `n/N`、消息操作（展开、复制、verbose）、sticky prompt。
- 普通模式也有 `MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE` 与 UUID anchor 管理。

天枢：
- 主屏靠 `CommitEngine` 写入终端 scrollback，用户用终端原生滚动回看。
- `/scroll`（pager overlay）存在，但缺乏搜索、跳转、消息级交互。

**优化建议**：
- 为 `/scroll` overlay 增加：
  - 消息级索引（从 session JSONL 重建）
  - `/` 搜索 + `n/N` 跳转
  - 选中消息展开完整内容（解决主屏截断）
  - 复制消息内容
- 这是长会话体验的核心缺口，优先做。

### 2.7 异常与降级层：天枢缺少 Recovery CLI

Claude Code：
- `CLAUDE_CODE_FORCE_RECOVERY_CLI=1` 启用 readline 回退模式。
- `--print` headless 模式完全绕过 Ink。

天枢：
- 有 `src/headless.ts` 的 headless 模式。
- 但 T9 若因终端能力检测失败、resize 异常等无法启动时，没有 readline 降级。

**优化建议**：
- 在 `src/main.ts` 中增加 `RIVET_FORCE_RECOVERY_CLI=1` 路径，启动一个简单 readline + agent callbacks 的 CLI。

### 2.8 遗留 React 组件：天枢 TUI 未完全统一

发现 `src/tui/command-palette.tsx` 仍使用 `ink` 的 `Box/Text/useInput`。说明 overlay 系统可能通过某种 bridge 渲染 React 组件，与 T9 纯 ANSI 引擎并存。

**优化建议**：
- 审计 `src/tui/**/*.tsx`，把命令面板、选择器等 overlay 统一改为纯 ANSI renderer，彻底消除对 Ink 的依赖，减少 bundle 体积和运行时 reconciler 开销。

---

## 3. 推荐优先级

| 优先级 | 优化项 | 影响 | 工作量 |
|---|---|---|---|
| **P0** | 为 `/scroll` overlay 增加搜索、跳转、消息展开 | 长会话可用性 | 中 |
| **P0** | 工具专用审批渲染器（bash diff/文件操作） | 安全确认体验 | 中 |
| **P1** | `SteerBuffer` → 优先级命令队列 | 多任务调度 | 中 |
| **P1** | 旧 scrollback 持久化归档，避免 1,000 行截断丢失 | 数据完整性 | 中 |
| **P1** | 统一 slash 命令元数据框架 | 可维护性 | 小~中 |
| **P2** | 输入框粘贴引用、typeahead | 输入效率 | 中 |
| **P2** | 工具结果去重/折叠启发式 | 信息密度 | 中 |
| **P2** | Recovery CLI 降级 | 鲁棒性 | 小 |
| **P3** | 继续拆分 `TuiApp` | 可维护性 | 持续 |
| **P3** | 将剩余 `.tsx` overlay 统一为 ANSI | 架构一致性 | 中 |

---

## 4. 关键文件映射

| 层级 | Claude Code | 天枢 |
|---|---|---|
| 主屏幕 | `src/screens/REPL.tsx` | `src/tui/engine/app.ts` |
| 输入框 | `src/components/PromptInput/PromptInput.tsx` | `src/tui/engine/input-line.ts` |
| 消息列表 | `src/components/Messages.tsx`、`VirtualMessageList.tsx` | `src/tui/engine/commit-engine.ts`、`live-engine.ts` |
| 流式渲染 | `src/components/Markdown.tsx`、`StreamingMarkdown.tsx` | `src/tui/engine/stream-renderer.ts`、`block-stream-writer.ts` |
| 权限确认 | `src/components/permissions/PermissionRequest.tsx` | `src/tui/engine/approval-intent-controller.ts` |
| 工具可视化 | `src/components/ToolUseLoader.tsx`、`MessageRow.tsx` | `src/tui/format/tool-card.ts`、`src/tui/engine/tool-group-controller.ts` |
| 命令队列 | `src/utils/messageQueueManager.ts` | `src/tui/steer-buffer.ts` |
| 命令路由 | `src/commands.ts`、`src/commands/*` | `src/tui/engine/slash-router.ts`、`src/tui/slash-commands.ts` |
| overlay | `src/components/FullscreenLayout.tsx` | `src/tui/engine/overlay-engine.ts`、`src/tui/command-palette.tsx` |
