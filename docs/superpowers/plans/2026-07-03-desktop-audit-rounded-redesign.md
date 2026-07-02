# 桌面端全面审计 + 圆角设计语言改造 计划

> **面向 AI 代理的工作者：** 分三个批次交付（P0 接线修复 → P1 对标补齐 → P2 视觉改造）。每批次独立可合入。步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 桌面端是用户主力入口（Windows 用户占比最高）。本计划解决三类问题：①功能接线缺口（TUI 有而桌面没有、或桌面双轨不一致）；②对标 Claude Desktop / Codex Desktop 的体验差距；③视觉升级为「浮岛式圆角」设计语言（自定义标题栏 + 卡片化面板 + 胶囊输入区）。

**现状基座（摸底结论，2026-07-03）：** Tauri 2 + React 18 + Vite；已有 JSON 主题 ×7 + `tokens.css` design tokens + Tailwind 4 桥接 + shadcn/ui；三栏 `react-resizable-panels` 布局；SSE + rAF 批处理 + 虚拟列表的事件流管线成熟。**改造是升级而非重写。**

**概念图：** `tianshu-desktop-rounded-mockup.png`（浮岛布局 / icon rail / 胶囊 composer / 上下文用量环）。

---

## 批次 P0 — 接线缺口修复（功能正确性，1-2 天粒度）

### P0-1 Composer slash 双轨统一（最高优先级）

**问题**（三层路径行为不一致）：
- sidecar `POST /prompt` 已接 `resolveAppPromptInput` + `requiredTools` 挂载（`src/server/session-routes.ts:417-440`）——与 TUI 对齐,是**正确的权威层**；
- 但 `Composer.tsx:285-294` 的客户端 guard 把「不在本地菜单里的 slash」直接 toast 拒绝,**根本不发给 server**——用户手打 `/write-plan`、`/plan-close` 永远到不了权威层；
- `ThreadView.tsx:318-322` 一带的 ~40 条 `ComposerCommand` 多数 `run()` 发**硬编码英文 prompt**,不经 ecosystem-workflows 翻译——与 server 路径产出不同的 prompt,行为漂移。

**修法**：
- [x] Composer guard 改为「白名单命中走本地 run()；未命中但以 `/` 开头 → **透传给 server**,由 `resolveAppPromptInput` 决定翻译或拒绝」。server 返回 unknown 时才 toast（复用 `useSendPrompt.onError` 的 toast + 输入回填通道；`isKnownSlashCommand` 及其单测删除）。
- [x] 逐条清理 `ComposerCommand`:`/review`、`/review max` 改发原始 slash 走 server 翻译；新增 `/write-plan`、`/plan-close` 菜单项（需参数,预填输入框而非直接发送）。`/team` `/council` 原本已发原始 slash。纯 UI 动作类保留本地。
- [x] 删除 `composer-commands.ts:2-4` 过时注释（「agent prompt-template slashes out of scope」）。
- [ ] 测试:e2e 冒烟 `/write-plan xxx` 在桌面可触发（待真机验证）。

### P0-2 `watchdog_recovery` 桌面 UI 卡片

reducer 与 ThreadView 已渲染（`event-reducer.ts:390-409`、`ThreadView.tsx:1087-1112`）——**已接线,无需动**。但上一批次审查确认的展示语义要补全:
- [x] 卡片区分 `autoContinue: true`（「⟳ 已自动恢复」弱提示）与 `stopReason: session-total/consecutive`（「⏹ 多次停滞已停手——点击继续」强提示 + 继续按钮,点击发 `continue`）。
- [x] `stopReason: 'suppressed'` 不渲染卡片（reducer 层直接不入 blocks,避免虚拟列表空行;带单测）。

### P0-3 `done` 事件显式处理

`event-reducer.ts:568-569` default 吞掉 `done`。当前靠 sessions 轮询兜底,但轮询间隔 2s 内 UI 状态是错的（流已结束仍显示 running）。
- [x] reducer 补 `case 'done'`:置 `status = event.data.status`,清 streaming 标记（带单测）。

### P0-4 ArtifactCard Review 按钮接线

`ArtifactCard.tsx:52` 按钮无 onClick。
- [x] 接线完成:store 新增 `requestReviewTab` action（置 `reviewVisible: true` + rev 递增的一次性 tab 请求）,ReviewPanel 消费请求切 tab,ArtifactCard 按 plan/task/其他 分别路由到 plan/task/review tab。

### P0-5 Windows 专项体检

- [x] **存储迁移 `.rivet` 双重拼接 bug(数据级,最急)**:修复完成——迁移源/目标改为 `old_home`/`new_home` 本身（RIVET_HOME 语义即数据根）,不再二次 join `.rivet`。Rust 侧回归测试未补（`apply_storage_location` 依赖 tauri AppHandle,单测成本高;cargo check 验证编译）。
- [x] **LOCALAPPDATA 为空的兜底**:`default_rivet_home` 补 `home_dir\AppData\Local` → `USERPROFILE` 两级 fallback,对齐 Node 侧 `paths.ts`。
- [ ] **代码签名缺失(SmartScreen)**:`tauri.conf.json:51-53` `certificateThumbprint: null`、`timestampUrl: ""` → 默认构建未签名,Windows 主用户群首次安装被 SmartScreen 拦截。接通 `build-signed.ps1` 流程进 release CI,或至少文档化绕行指引。（需证书/CI 权限,单独排期）
- [x] **审批 modal 路径展示**:`WorkspaceSurface.tsx` `getApprovalIntent` 换 `split(/[\\/]/)`;agent 侧 `commit-nudge.ts`、`task-planner.ts`、`skill-distill.ts` 同步修复（三处各一行,未抽共享 helper——语义各异:top-dir/module-key/stem,强行统一反而失真）。
- [x] **集成终端 shell + 编码**:`pty.rs` 默认 shell 改为 Git Bash 优先（探测链对齐 `src/platform.ts::resolveGitBashPath`:env 覆盖 → `where git` 推导 → 常见安装位置;`RIVET_USE_POWERSHELL` 可强制回 PowerShell）;PowerShell 启动注入 `[Console]::InputEncoding/OutputEncoding=UTF8`,cmd 注入 `chcp 65001`。未做独立 UI 选择器（`pty_spawn` 本就接受 shell 参数,后续设置页需要时再接）。
- [ ] **字体**:`tokens.css:12` 已含 Microsoft YaHei 回退,但 Windows 下 Inter 数字与中文混排基线偏移常见 → 验证并考虑 `font-feature-settings` 或 Segoe UI Variable 优先。
- [ ] **首启体验**:FirstRunGitDialog 已有(`App.tsx:275-281`,对标 Claude Desktop 的 Git for Windows 强制);补 Node runtime 探测失败时的友好引导(`lib.rs:369-410` 已探测,但失败 UI 待验证)。
- [ ] **托盘关闭行为**:关闭=隐藏托盘(`lib.rs:818-823`)对 Windows 用户不直观 → 首次关闭时弹一次「最小化到托盘/直接退出」选择并记忆。

### P0-6 已建未挂的接线尾巴(第二轮盘点补充)

- [x] **`attention`(Inbox)Surface 无导航入口**:已加入 Sidebar `CORE_SURFACES` 与 `SURFACE_ORDER`（Cmd+5）。
- [x] **委派 worker 无中止按钮**:DelegationSurface 详情侧栏对 running 节点显示「中止此 worker」,走 `abortDelegateWorker`,成败 toast。
- [x] **MCP 设置不展示工具列表**:McpSettings 服务器行加「工具」展开按钮,懒加载 `listMcpServerTools`,展示 name + description。
- [ ] 低优先:`GET /worktrees`、`GET /tasks/:id/events`、`GET /schedule/status` 有端点无 client/UI——随 P1 相关面板需要时再接,不单独立项。

> 勘误:第二轮盘点称 `watchdog_recovery` 未渲染是误报——`event-reducer.ts:390-409` + `ThreadView.tsx:1087-1112` + 三个单测均在。P0-2 维持「展示语义打磨」定位不变。

---

## 批次 P1 — 对标 Claude Desktop 的体验补齐

对标源:code.claude.com/docs/desktop（2026-06 版）。桌面已有且不落后的:会话并行 + worktree 隔离、diff 审查、内嵌浏览器预览（BrowserPanel）、集成终端、Mission Control 多会话监控、计划面板、委派树、@mention + 图片拖放、SSE 断线重连。**真正的差距按性价比排序:**

### P1-1 Composer 状态芯片组（对标「送信ボタンの横」控件群）

Claude Desktop 把模型、权限模式、上下文用量全部内联在输入框旁,这是它「可视化好于 Codex」口碑的核心。桌面端目前模型切换埋在菜单里,上下文用量不可见。
- [x] Composer 底部加芯片行:**模型芯片**（原有 ModelPicker 已内联）、**权限模式芯片**（AutonomyControl compact 从 header 移入 composer-actions,接 `setApprovalMode`）、**上下文用量环**（`ContextRing` SVG,contextTokens/contextWindow,>80% 变橙提示 /compact）。
- [x] 上下文环点击展开明细 popover(上下文/本轮增量/缓存命中率/缓存读创建)——DeepSeek 前缀缓存独有可视化。

### P1-2 视图模式（Normal / Verbose / Summary）

对标 transcript view 三档。长会话里工具调用刷屏是主要抱怨源。
- [x] ThreadView 加视图模式切换（⌘/Ctrl+O 循环,header 芯片可点击）:Normal=timeline 折叠(现状);Verbose=timeline 组强制展开;Summary=只保留 user/assistant/error/turn/steer 块。存 localStorage(`tianshu.viewMode`),状态在全局 store。

### P1-3 Diff 行内评论 → 回灌 prompt

对标「diff 内任意行点击评论,Cmd/Ctrl+Enter 一次性送出,Claude 按评论修改」。这是评审闭环的杀手锏。
- [x] `DiffView` 行评论基建已存在（ReviewPanel artifact diff 已接 sendArtifactFeedback）;本次补 **ChangesTab（工作树 diff）** 行评论:跨文件累积,「发送 N 条评论」汇总为 `文件:行号 — 评论` 结构化 prompt,经 handleSteer 通道回灌（运行中 steer,空闲直发）。

### P1-4 Side Chat（不污染主线程的旁路提问）

对标 `/btw` + Cmd+;。天枢有现成的 delegate 基建,旁路问题可下沉为一个只读 worker 会话（共享主会话上下文快照,不写入主线程 history——保前缀缓存的架构本来就适合这个）。
- [x] MVP:`SideChat` 右侧抽屉（⌘; 或 header 💬 切换),懒创建真实轻会话（标题「旁路 · …」),首条 prompt 前缀注入主会话最近 6 条 user/assistant 摘录(每条截 600 字);顶部明示「此对话不影响主任务」。复用 useSessionEvents 流。

### P1-5 会话列表强化

- [x] 按项目分组已有;补状态筛选(全部/运行中/待处理/空闲)——SlidersHorizontal 图标展开筛选芯片行,attention = pendingApprovals>0 或 failed。
- [x] OS 通知核实已完备:`use-global-notifications.ts` 已覆盖完成/失败/待审批,带点击跳转路由与 never/background/always 偏好——无需新增。

### P1-6 快捷键体系

- [x] 对齐键位:Ctrl+Tab / Ctrl+Shift+Tab 切会话(保留 ⌘⇧[/])、Esc 空输入停止运行、Ctrl+` 终端(保留 ⌘J)、⌘O 视图模式、⌘/ 打开新的 `ShortcutOverlay` 快捷键速查(三组:全局/会话与布局/输入框)。

### P1-7 i18n 收尾（中低优先）

13 个 namespace 已建但仅 ~8 文件使用,App banner/ThreadView 状态标签/审批 modal 全硬编码中文。用户群以中文为主,不阻塞,但:
- [x] 语音识别 lang 跟随 i18n locale(en → en-US,默认 zh-CN)。全量 t() 覆盖仍为后续渐进项。

---

## 批次 P2 — 圆角设计语言改造(「浮岛」视觉体系)

参考概念图。核心理念:**窗口即画布,面板即浮岛**——去原生标题栏,所有功能区变成圆角卡片悬浮在统一底色上,间隙呼吸,阴影分层。这是 Claude Desktop / Arc / Linear 一脉的气质来源。

### P2-1 Design tokens 升级(`styles/tokens.css`)

现值 radius 6/8/12,偏保守。改为:

```css
--radius-sm: 8px;    /* chip、小按钮 */
--radius-md: 12px;   /* 输入框、列表项、消息卡 */
--radius-lg: 16px;   /* 面板浮岛、modal */
--radius-xl: 20px;   /* 窗口级容器、composer 胶囊 */
--radius-pill: 999px;

/* 浮岛体系新增 */
--island-gap: 10px;            /* 浮岛间隙 */
--island-bg: /* 面板面色,比画布浅一档 */;
--canvas-bg: /* 窗口底色,最深 */;
--shadow-island: 0 1px 2px rgb(0 0 0 / .2), 0 4px 16px rgb(0 0 0 / .15);
--shadow-float: 0 8px 32px rgb(0 0 0 / .35);  /* modal/popover */
```

- [x] 7 套 JSON 主题各补 `canvas-bg`/`island-bg`/阴影 token(暗色系拉开画布与浮岛的明度差;浅色系用描边 + 弱阴影替代)。
- [x] 动效:面板出现 `surface-in` 已有,补 160ms 的 radius/shadow 过渡统一手感(`--dur-island`)。

### P2-2 自定义标题栏(Windows 重点)

现状 `tauri.conf.json` 用系统原生标题栏,与圆角浮岛气质割裂。
- [x] `decorations: false` + 自绘标题栏:`tauri.windows.conf.json` + `TitleBar.tsx`——左侧 logo + 会话标题(点击重命名),右侧 最小化/最大化/关闭(hover 红色关闭);`data-tauri-drag-region` 拖拽 + 双击最大化。⚠️ 需 Windows 实机验证。
- [x] macOS 走 `titleBarStyle: Overlay`(`tauri.macos.conf.json`)保留原生红绿灯;`html[data-platform="mac"]` 给 Rail 顶部留 34px。⚠️ 需 macOS 打包验证红绿灯与 Rail 不重叠。
- [x] Windows 边缘 resize 依赖 `shadow: true` 的原生 resize border(未手写 startResizeDragging 边条);最大化时 `html[data-maximized]` 去圆角去间隙。⚠️ 需 Windows 实机验证边缘拖拽。
- [ ] 已有的 Mica/vibrancy(`lib.rs:209-223`)与浮岛叠加验证:玻璃态下浮岛用半透明 `island-bg` + backdrop-blur,solid 模式用实色。(待 Windows 实机)

### P2-3 布局改造(`WorkspaceSurface`)

- [x] **挂载 `Rail.tsx`**——App shell 接线(含 attention 徽标计数),56px 浮岛;ProjectSidebar 瘦身为纯项目/会话列表(移除 surface 导航与底部设置钮)。
- [x] 三栏 Panel 之间加 `--island-gap`,每栏包 `--radius-lg` 卡片 + `--shadow-island`;resize handle 藏进间隙(hover 显 accent 条)。
- [x] Composer 胶囊浮层已有(`composer-float-inner`),升级为 `--radius-xl` + `--shadow-float`。
- [x] 消息区:user 气泡收敛为 `--radius-md` + 单角收小;assistant 保持通栏自然流;工具折叠组随 radius token 升级(16px)。
- [x] JobsDock / ApprovalModal / modal 统一 `--radius-lg` + `--shadow-float`。

### P2-4 验收

- [x] 浏览器 dev 模式截图走查:dark / sakura 两主题确认浮岛间隙、圆角、画布明度差正常;⚠️ 7 主题 × glass/solid × Win11/Win10/macOS 全矩阵待实机。
- [x] 阴影只打在三个面板容器 + Rail 上,不打在列表项(虚拟列表无逐项 box-shadow)。
- [x] 窄窗(<1200px)`--island-gap` 收窄为 6px(media query);审查面板自动折叠逻辑不变。

---

## 交付顺序与依赖

```
P0-1 slash 统一 ──┐
P0-2..5 独立并行 ─┼→ 可先合入(纯功能,不动视觉)
                  │
P2-1 tokens → P2-2 标题栏 → P2-3 布局(Rail 挂载可提前到 P0 一起做)
                  │
P1-1 芯片组 依赖 P2-3 的 composer 胶囊(或先做逻辑后套壳)
P1-2..7 独立,穿插排期
```

## Windows 加固备忘(不阻塞本轮,择机排入)

来自 Windows 兼容性专项调研的次级发现,基础已较厚(Git Bash 优先级链、GBK 流解码、EPERM 过滤、CRLF 编辑策略、`\\?\` 剥离、NTFS slug 消毒均已在):

- `kill_sidecar()`(`lib.rs:701-708`)仅 `Child::kill()`,不像 Node 侧走 `taskkill /T` 清进程树——现靠 `RIVET_PARENT_PID` watchdog + process-tracker 双向兜底,强杀场景可能短暂残留 node.exe。
- sidecar 崩溃后无自动重 spawn,前端进 fatal 态需重启应用。
- git 未统一 `core.autocrlf` 策略,checkout CRLF + agent 写 LF 可能产生 mixed-EOL diff 噪音。
- EPERM/bash smoke 测试在 Windows CI 上被 skip(`eperm-skip.test.ts:28-30`),生产路径无持续覆盖。
- 无开机自启选项;无 per-monitor DPI 显式调优。
- `eperm-filter.ts:47-52` 非 EPERM 的 unhandledRejection 未 re-emit,新型噪声可能静默。

## 明确不做(本轮)

- 云端会话 / SSH 会话(Claude Desktop 的 Remote/SSH 环境选择)——基建不在,独立立项
- Computer Use / 屏幕控制——安全面完全不同
- 拖拽任意面板布局(Claude 的 drag-pane)——`react-resizable-panels` 三栏够用,拖拽重排收益/复杂度比低
- Electron 迁移——Tauri 2 现状健康,无理由动
