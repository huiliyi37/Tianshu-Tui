# 桌面端布局优化审查报告

> 2026-06-27 · 对照 Tanzo / Cursor / Codex 布局,审查天枢桌面端的布局结构和交互设计

## 1. 当前布局分析

### 布局骨架

```
┌──────┬─────────────┬──────────────────────┬──────────────┐
│ Rail │ ProjectSide │   Conversation       │ ReviewPanel  │
│ 56px │  bar 264px  │   (ThreadView +      │  360px       │
│      │             │   Composer +         │  (tabs:      │
│ icon │  session    │   TerminalTabs)      │   review/    │
│ nav  │  tree       │                      │   plan/task/ │
│      │             │                      │   files/diff)│
│      │             │                      │              │
│ 🏠   │ ▸ project-a │  thread header       │  [Review]    │
│ ⏰   │   session-1 │  ─────────────       │  ┌─────────┐ │
│ 🔔   │   session-2 │  messages...         │  │ pending │ │
│ 🧩   │ ▸ project-b │                      │  │ approval│ │
│ 🌿   │             │                      │  └─────────┘ │
│ 📊   │ + 新线程    │  ─────────────       │              │
│ 🌐   │             │  Composer            │  todos...    │
│ ⚙️   │             │                      │              │
└──────┴─────────────┴──────────────────────┴──────────────┘
```

非 workspace surface:
```
┌──────┬─────────────────────────────────────────────────────┐
│ Rail │ [← 工作台]  委派树                    [空]          │ ← surface-topbar 44px
│ icon │ ┌─────────────────────────────────────────────────┐ │
│ nav  │ │                                                 │ │
│      │ │  surface 内容（全宽）                            │ │
│      │ │                                                 │ │
│      │ └─────────────────────────────────────────────────┘ │
└──────┴─────────────────────────────────────────────────────┘
```

### 优点

1. **4 栏 workspace 信息密度高** — 左到右是导航 → 项目 → 对话 → 审查,视线从左到右自然流动,所有关键信息一屏可见
2. **Rail 极简** — 56px 纯图标导航,不占空间,8 个 surface 一键切换
3. **ReviewPanel 多 tab** — review/plan/task/files/diff/github 6 个 tab 复用同一空间,不堆叠
4. **ThreadView header 信息丰富** — 自治档位 + 状态点 + 模型 + 上下文用量条 + cache 命中率 + token 增量,一排看完 agent 状态
5. **可拖拽面板** — react-resizable-panels 已接入,用户可自定义比例
6. **毛玻璃分层** — 5 层 surface token + WallpaperLayer,视觉深度好

### 问题

1. **非 workspace surface 的 surface-topbar 太空** — 只有"← 工作台" + surface 名 + 一个空 `<span/>`,44px 高度大量留白
2. **非 workspace surface 全宽** — 委派树/Insights/Git 等占满 Rail 右侧全部空间,在宽屏(>1400px)上文本行过长,可读性差
3. **ThreadView header 在小屏溢出** — header 塞了 7+ 个元素(model/mode/ctx-bar/cache-chip/delta/close),<1000px 时会挤
4. **空状态(无活动会话)体验弱** — 只有一行"选择左侧线程" + 一个按钮,没有引导性的 onboarding 内容
5. **surface 切换无过渡** — 点击 Rail 图标瞬间切换,无 fade/slide,视觉跳跃感强
6. **Rail 无 active 指示器的动画** — `.rail-item.active::before` 是静态左边框,无滑入动画
7. **Composer 在无活动会话时不可见** — 用户必须先创建/选中一个会话才能看到 Composer,入口隐藏太深
8. **ReviewPanel 6 个 tab 在窄屏溢出** — 360px 放 6 个 tab + 内容,部分 tab 标签被截断

---

## 2. 优化建议(按 ROI 排序)

### P0 — 立即做(高价值、低工作量)

#### 2.1 非 workspace surface 增加 max-width 约束

- **问题**:委派树/Insights/Git/Settings 等 surface 占满全宽(>1400px),文本行过长,可读性差。DelegationSurface 已有 `max-w-[1100px]` 但其他 surface 没有。
- **方案**:在 `.surface` 全局规则里加 `max-width: 1400px; margin: 0 auto;`,或给每个 surface 组件的根 div 加 `mx-auto max-w-[1400px]`。同时 surface-topbar 也约束到同宽。
- **效果**:宽屏可读性大幅提升,内容居中视觉平衡。
- **工作量**:30 分钟(CSS 一行 + 各 surface 根 div 加 class)。

#### 2.2 surface-topbar 填充统计信息

- **问题**:非 workspace surface 的 topbar 只有一个标题,44px 高度浪费。对比 Tanzo 的 PageHeader 填满了标题 + 统计数字 + 操作按钮。
- **方案**:给每个 surface 的 topbar 注入上下文信息:
  - **委派树**:节点总数 · 运行中数 · 需关注数
  - **Insights**:总会话数 · 总 token · 总成本
  - **Git**:分支名 · 待提交数
  - **设置**:无额外信息,保持简洁
- **效果**:topbar 从"空架子"变成"信息条",用户一眼看到 surface 的关键数据。
- **工作量**:1 小时(每个 surface 加 2-3 个 `<span>` 统计标签)。

#### 2.3 Rail active 指示器滑入动画

- **问题**:`.rail-item.active::before` 是静态 3px 左边框,切换 surface 时没有过渡,视觉跳跃。
- **方案**:把 active 指示器改为绝对定位的浮动条,用 CSS transition 的 `transform: translateY()` 实现滑入。或用 Framer Motion `layoutId` 做共享元素动画(但项目目前没装 motion,用 CSS 即可)。
- **效果**:surface 切换有了流畅的视觉引导,质感提升。
- **工作量**:30 分钟(CSS transform transition + JS 计算位置)。

#### 2.4 surface 切换淡入动画

- **问题**:surface 内容切换是瞬间的,视觉跳跃。
- **方案**:给 `.surface` 加 `animation: surface-in var(--dur) var(--ease)`,`keyframes surface-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }`。用 React key 触发重渲染动画。
- **效果**:切换顺滑,消除视觉跳跃。
- **工作量**:15 分钟(CSS keyframes + animation 属性)。

### P1 — 短期做(中价值、中工作量)

#### 2.5 空状态 onboarding 卡片

- **问题**:无活动会话时只有一行文字 + 按钮,缺乏引导。用户第一次打开不知道能做什么。
- **方案**:把 `.thread-empty` 改为一张居中的 onboarding 卡片:
  - 天枢 logo / 星域 glyph
  - "开始你的第一个线程"
  - 3 个快捷入口卡片:新建空线程 / 导入项目 / 查看文档
  - 最近项目列表(如果有)
- **效果**:首次使用体验从"空白"变成"引导",降低上手门槛。
- **工作量**:2 小时(组件 + CSS + 数据)。

#### 2.6 ThreadView header 响应式折叠

- **问题**:header 塞了 model/mode/ctx-bar/cache-chip/delta/status/close 共 7+ 元素,<1000px 时溢出或截断。
- **方案**:
  - 宽屏(>1200px):全部展开
  - 中屏(900-1200px):隐藏 ctx-delta 和 cache-chip(合并到 ctx-bar tooltip)
  - 窄屏(<900px):只保留 model + status + close,其余收入一个 `⋯` 弹出菜单
  - 用 CSS `@media` + `display: none` 控制,或用 `useMediaQuery` hook
- **效果**:小屏不再溢出,信息密度自适应。
- **工作量**:1.5 小时(CSS media query + 可能的 JS 折叠逻辑)。

#### 2.7 全局 Composer 浮层入口

- **问题**:Composer 只在有活动会话时可见。用户想快速提问必须先创建会话。Cursor 和 ChatGPT 都有全局输入框。
- **方案**:在 Rail 底部加一个悬浮 Composer 入口(类似 ChatGPT 侧栏底部的新对话按钮),点击:
  - 如果有活动项目 → 直接打开"新建线程"对话框
  - 如果无项目 → 弹出项目选择器
  或者更激进:把 Composer 提升到 main 区域底部常驻,无会话时也能输入(自动创建临时会话)。
- **效果**:降低"快速提问"的交互步骤。
- **工作量**:2-3 小时(取决于方案复杂度)。

#### 2.8 ReviewPanel tab 在窄屏可滚动

- **问题**:6 个 tab(review/plan/task/files/diff/github)在 360px 宽度里部分被截断。
- **方案**:给 `.review-tabs` 加 `overflow-x: auto; scrollbar-width: none;`(隐藏滚动条),让 tab 可水平滚动。或者用优先级排序:review 永远可见,其余可折叠到 `⋯` 菜单。
- **效果**:窄屏所有 tab 可达。
- **工作量**:30 分钟(CSS overflow)。

### P2 — 中期做(高价值、高工作量)

#### 2.9 非 workspace surface 改为 sidebar + content 双栏

- **问题**:委派树/Insights/Git 等全宽 surface 的信息结构天然是"列表 + 详情"或"导航 + 内容",当前全部单栏铺开。
- **方案**:统一用 ResizablePanelGroup,左栏放导航/列表,右栏放详情。例如:
  - **Git**: 左栏 commit 列表 → 右栏 commit diff
  - **Insights**: 左栏会话列表 → 右栏成本/token 图表
  - **Settings**: 左栏分类导航 → 右栏设置项(参考 Tanzo SettingsNav)
- **效果**:信息结构化,减少滚动,对标 Cursor 的多面板布局。
- **工作量**:每个 surface 半天到一天。

#### 2.10 Settings 改为分类导航 + 内容双栏

- **问题**:当前 SettingsSurface 是单栏垂直滚动,所有设置项堆在一起(外观/壁纸/通知/autonomy/MCP...)。
- **方案**:参考 Tanzo 和 VS Code,左栏分类树(外观/语言/终端/集成/关于),右栏对应设置项。用 ResizablePanelGroup。
- **效果**:设置项结构化,查找快。
- **工作量**:3 小时。

#### 2.11 Conversation 消息区气泡/卡片样式优化

- **问题**:当前消息渲染是纯 markdown 流,无视觉分隔。用户/agent 消息没有明确的视觉边界。
- **方案**:给每条消息加一个轻量卡片容器(圆角 + 微弱边框 + 头像/角色标签),参考 ChatGPT 和 Cursor 的消息气泡。不要过重——用 `border + radius + padding` 即可,不用背景色块。
- **效果**:消息层次更清晰,长对话可读性提升。
- **工作量**:2 小时。

#### 2.12 工作区专注模式(Zen Mode)

- **问题**:4 栏 workspace 信息密度高,但有时用户只想专注对话。
- **方案**:增加一个"专注模式"快捷键(Cmd+.),一键隐藏 ProjectSidebar + ReviewPanel,只留 Conversation。再按一次恢复。类似 Cursor 的 Zen Mode。
- **效果**:深度工作时不被侧栏干扰。
- **工作量**:1 小时(复用 panelRef collapse API)。

---

## 3. 与竞品布局对比

| 维度 | 天枢 | Cursor | Tanzo | Codex |
|------|------|--------|-------|-------|
| **导航** | 56px Rail(纯图标) | 左栏活动栏(图标) | ResizablePanel 侧栏 | 无独立导航 |
| **会话列表** | ProjectSidebar(项目树) | 侧栏会话列表 | ConversationSidebar(虚拟化) | 顶部 tab |
| **对话区** | ThreadView(虚拟化) | 编辑器内嵌 chat | ActiveChat(Virtuoso) | 全屏终端 |
| **辅助面板** | ReviewPanel(6 tab) | 无独立面板 | 无 | 无 |
| **终端** | TerminalTabs(多 tab) | 内嵌终端 | 无 | 主界面 |
| **header** | ThreadView header(信息密集) | 标题栏 + 面包屑 | PageHeader(统一组件) | 无 |
| **空状态** | 一行文字 + 按钮 | 最近项目网格 | 空对话引导 | 命令行提示 |

**天枢独有优势**:ReviewPanel 多 tab(review/plan/task/files/diff/github)是 Cursor/Tanzo 都没有的——它把"审查 + 计划 + 任务 + 文件 + diff + PR"集中在一个面板,这是天枢作为 agent-first 工具的核心差异化。

**天枢主要差距**:
1. 非 workspace surface 的布局质量远低于 workspace(全宽、空 topbar)
2. 空状态和 onboarding 体验弱
3. 设置页未结构化(单栏堆叠 vs VS Code/Tanzo 的分类导航)

---

## 4. 不建议改的(保持差异化)

| 保持现状 | 原因 |
|---------|------|
| 4 栏 workspace | 这是天枢的核心信息密度优势,不要为了"简洁"删栏 |
| ThreadView header 信息密度 | model/ctx-bar/cache-chip 是 agent-first 工具的必备反馈,不能简化 |
| TerminalTabs 在对话区底部 | 对标 Codex 的"终端即一等公民"定位 |
| ReviewPanel 6 tab | 竞品没有的东西正是护城河 |
