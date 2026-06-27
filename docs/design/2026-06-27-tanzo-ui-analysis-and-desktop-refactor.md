# Tanzo UI 分析与天枢桌面端改造建议

> 2026-06-27 · 对比分析 Tanzo (`github.com/f4tumnigrum/Tanzo`) 与天枢桌面端 (`opencode-tui/desktop`)

## 1. 两个项目的技术栈对比

| 维度 | Tanzo | 天枢桌面端 |
|------|-------|-----------|
| **运行时** | Electron 41 (main/preload/renderer 三进程) | Vite SPA (浏览器/Tauri) |
| **React** | React 19 + React Router 7 | React 18 (无路由) |
| **样式系统** | **Tailwind CSS 4** + shadcn/ui 组件库 + CVA | **手写 CSS** + CSS 变量 tokens |
| **状态管理** | Zustand + TanStack Query/Table | 自研 store (useReducer) |
| **图标** | **lucide-react** (专业图标库) | 手写 SVG path |
| **组件库** | shadcn/ui (30+ 组件) + base-ui/react | 全手写 |
| **国际化** | i18next (en/zh-CN, 50KB×2) | 无 (硬编码中文) |
| **虚拟列表** | react-virtuoso | 无 |
| **可调整面板** | react-resizable-panels | CSS grid (固定列宽) |
| **动画** | motion (Framer Motion) + tw-animate-css | CSS transition |
| **Toast** | sonner | 无 |
| **颜色空间** | **oklch** (感知均匀) | **hex** (#0d0d10) |
| **壁纸层** | WallpaperLayer (用户自定义壁纸 + 毛玻璃) | 无 |
| **桌面宠物** | PetApp (精灵动画 + 审批气泡) | 无 |

---

## 2. Tanzo 的 UI 设计亮点（天枢缺失的）

### 2.1 毛玻璃分层架构 (Surface System) ★★★★★

这是 Tanzo 最突出的视觉设计。它把整个界面拆成 5 个"表面层" (surface)，每层有独立的透明度、模糊、饱和度：

```css
/* 暗色模式 + 壁纸激活时 */
--sidebar-surface-bg: color-mix(in oklab, var(--background) 38%, transparent);
--sidebar-surface-blur: 38px;
--sidebar-surface-saturation: 1.16;
--main-surface-bg: color-mix(in oklab, var(--background) 72%, transparent);
--main-surface-blur: 22px;
--compose-surface-bg: color-mix(in oklab, var(--input) 38%, ...);
--compose-surface-blur: 20px;
```

配合 `WallpaperLayer` 组件：用户可以设置桌面壁纸，应用整体变为**半透明毛玻璃**效果（类似 macOS vibrancy / Windows acrylic）。5 层表面各有不同的透明度梯度，形成视觉深度。

天枢桌面端目前是完全不透明的实色面板 (`--panel: #151519`)，没有透明度层次。

### 2.2 可拖拽调整的面板布局 ★★★★

```tsx
<ResizablePanelGroup orientation="horizontal">
  <ResizablePanel id="sidebar" minSize="18%" maxSize="40%" collapsible />
  <ResizableHandle />  // 渐变拖拽条
  <ResizablePanel id="content" minSize="30%" />
</ResizablePanelGroup>
```

用户可以**拖拽调整侧栏宽度**、**折叠/展开**。天枢目前用 CSS grid 固定列宽 (`264px minmax(0,1fr) 360px`)，无法拖拽。

### 2.3 虚拟化消息列表 ★★★★

```tsx
<Virtuoso
  messages={visibleMessages}
  composerOffset={composerOffset}  // 动态测量 composer 高度
/>
```

Tanzo 用 `react-virtuoso` 虚拟化长消息列表，万条消息也不卡。天枢目前是全量渲染 DOM。

### 2.4 oklch 色彩空间 ★★★

```css
/* Tanzo: oklch — 感知均匀，亮度变化时色相不漂移 */
--background: oklch(0.16 0.012 255);
--primary: oklch(0.72 0.14 245);

/* 天枢: hex — 暗色模式下灰阶过渡不平滑 */
--bg: #0d0d10;
--accent: #5aa9ff;
```

oklch 是 CSS Color 4 的现代色彩空间，在亮度梯度上色相保持稳定。hex 在暗→亮过渡时会出现色相偏移。

### 2.5 桌面宠物 (Pet) ★★★

Tanzo 有一个独立的 `pet.html` 窗口，渲染一个精灵动画角色。它：
- 在 agent 需要审批时弹出 `ApprovalBubble`
- 支持快速输入 `QuickInputBubble`
- 可拖拽、有动画状态 (idle/happy/thinking)

这是天枢星域人格系统在桌面端的天然延伸——把星域角色可视化。

### 2.6 统一的 PageHeader 组件 ★★★

```tsx
<PageHeader
  title={headerTitle}
  leadingActions={<SidebarToggleButton />}
  actions={<>
    <TaskOverviewPill />     {/* 任务概览胶囊 */}
    <WorkspaceGitPill />     {/* Git 状态胶囊 */}
  </>}
  stats={[{ value: 5, label: '消息' }]}
/>
```

每个页面有统一的 header：标题 + 统计数字 + 操作按钮 + 窗口控制。天枢各 surface 的 header 风格不统一。

### 2.7 i18n 国际化 ★★

50KB×2 的翻译文件 (en/zh-CN)，所有 UI 文本走 `t('key')`。天枢全部硬编码中文。

### 2.8 Toast 通知 (sonner) ★★

```tsx
import { toast } from 'sonner'
toast.info('无法在运行中压缩')
```

轻量 toast 替代 alert。天枢没有 toast 系统。

---

## 3. 天枢桌面端已有的优势（不需要改的）

| 能力 | 天枢 | Tanzo |
|------|------|-------|
| **Surface 系统** | 8 个 surface + Cmd+1..8 + Command Palette | 路由式 6 页 |
| **Composer** | slash 命令补全 + 未知命令拦截 + 语音输入 + 图片粘贴 | slash + 模型选择器 |
| **Markdown** | KaTeX 数学公式 (刚完成) | KaTeX (相同) |
| **委派树** | 独立 Surface + 详情面板 (刚完成) | 无独立视图 |
| **Git 集成** | GitSurface | GitReviewDialog |
| **Insights** | 成本/token 分析面板 | Usage 页面 |
| **安全沙箱** | 无 (SPA 模式) | 完整 (Electron + approval) |

---

## 4. 改造建议（按 ROI 排序）

### P0 — 立即做（高价值、低风险）

#### 4.1 引入 lucide-react 图标库
**现状**：天枢的 Rail/ProjectSidebar 里手写了 8 个 SVG path 字符串（`'M4 5h16...'`），维护困难、风格不统一、无 accessibility。
**改造**：
```bash
bun add lucide-react
```
替换所有 `NavIcon` 里的 path 字符串为 `<Home />` `<GitBranch />` `<Users />` 等。
**工作量**：2 小时。**风险**：零。**收益**：图标一致性 + accessibility + 减少 200 行手写 path。

#### 4.2 oklch 色彩迁移
**现状**：`tokens.css` 全部用 hex，暗色模式下灰阶过渡不平滑。
**改造**：把 `--bg`/`--panel`/`--text` 等核心 token 从 hex 转为 oklch：
```css
/* Before */
--bg: #0d0d10;
--panel: #151519;
/* After */
--bg: oklch(0.16 0.012 255);
--panel: oklch(0.20 0.012 255);
```
**工作量**：1 小时。**风险**：低（oklch 在所有现代浏览器支持）。**收益**：暗色模式视觉质量提升。

### P1 — 短期做（中价值、中工作量）

#### 4.3 可拖拽面板布局
**现状**：`.workspace` grid 固定 `264px 1fr 360px`，用户无法调整。
**改造**：引入 `react-resizable-panels`，把 workspace 的 sidebar/review 面板改为可拖拽：
```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
```
**工作量**：半天。**风险**：中（需测试拖拽状态持久化）。**收益**：用户可定制工作区。

#### 4.4 Toast 通知系统
**现状**：无 toast，错误提示用内联 div。
**改造**：
```bash
bun add sonner
```
在 App 根部挂 `<Toaster />`，替换 `slashError` 等内联错误为 `toast.error()`。
**工作量**：2 小时。**风险**：零。**收益**：统一通知体验。

#### 4.5 虚拟化消息列表
**现状**：`ThreadView` 全量渲染所有消息 DOM，长会话卡顿。
**改造**：
```bash
bun add react-virtuoso
```
把消息列表改为 `<Virtuoso>` 虚拟滚动。
**工作量**：1 天。**风险**：中（需处理流式消息的动态高度）。**收益**：长会话性能。

### P2 — 中期做（高价值、高工作量）

#### 4.6 毛玻璃分层架构
**现状**：实色面板，无透明度层次。
**改造**：
1. `tokens.css` 增加 surface token 体系（`--sidebar-surface-bg`/`--main-surface-bg`/`--compose-surface-bg` 等）
2. 增加 `WallpaperLayer` 组件（用户可选壁纸）
3. surface 层用 `backdrop-filter: blur()` + `color-mix()`
4. 各面板背景从 `var(--panel)` 改为 `var(--sidebar-surface-bg)`
**工作量**：2 天。**风险**：中（`backdrop-filter` 在部分浏览器有性能问题）。**收益**：视觉质感大幅提升。

#### 4.7 桌面宠物 / 星域角色可视化
**现状**：星域人格系统纯文本（star-domain.ts），无可视化。
**改造**：
1. 新增独立的 `pet.html` 窗口（Tauri multiple windows 或 Electron BrowserWindow）
2. 渲染当前星位的精灵动画（需准备 sprite 资源）
3. agent 需要审批时弹出 `ApprovalBubble`
4. 可拖拽 + 状态动画 (idle/thinking/running)
**工作量**：3 天。**风险**：高（需 sprite 资源 + 窗口管理）。**收益**：差异化护城河。

### P3 — 长期做（基础设施）

#### 4.8 Tailwind CSS 迁移
**现状**：1936 行手写 CSS (`styles.css`)，无原子类。
**改造**：引入 Tailwind 4，逐步把组件样式迁移为 utility class。
**工作量**：1 周+。**风险**：高（全量重写样式层）。**收益**：开发效率 + 一致性。

#### 4.9 i18n 国际化
**现状**：全部硬编码中文。
**改造**：引入 i18next，提取所有 UI 字符串到翻译文件。
**工作量**：3 天。**风险**：低。**收益**：国际化支持。

---

## 5. 不建议照搬的部分

| Tanzo 特性 | 原因 |
|-----------|------|
| Electron 三进程模型 | 天枢是 Vite SPA，架构完全不同；改 Electron = 推倒重来 |
| shadcn/ui 全量组件库 | 30+ 组件，天枢只需要其中 5-6 个；直接 cherry-pick 更轻 |
| React Router 7 | 天枢用 surface 状态机切换，不需要 URL 路由 |
| TanStack Query | 天枢用自研 SSE 流式状态，与 Query 的轮询模型冲突 |
| motion (Framer Motion) | 过重，天枢的 CSS transition 够用 |
| base-ui/react | 底层原语库，天枢不需要这个抽象层 |
