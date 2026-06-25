# 天枢 Desktop 侧边栏 Cursor 化改造计划

> 目标：参考 Cursor Agent 3.0 侧边栏的样式与布局，对桌面端左右侧边栏进行第二轮深度优化，使其更符合现代 agent IDE 的视觉语言。

---

## 一、Cursor 侧边栏参考分析

从参考截图可提炼出以下视觉与交互模式：

### 左侧边栏
- **整体结构**：单一连续侧边栏，从上到下分为「顶部操作、主导航、项目/会话树、底部账户」。
- **顶部操作**：显眼的 `New Agent` 大按钮（带左侧 + 号、快捷键 hint），下方紧跟一条分隔线。
- **主导航**：图标 + 文字的扁平列表项（Automations / Customize / Repositories），右侧可带展开 chevron 或操作按钮。
- **项目树**：
  - 项目作为可折叠分组（folder icon + 项目名）。
  - 展开后显示该项目下的 agent/chat 列表。
  - 当前项使用左侧 accent 条 + 背景高亮。
  - 空状态显示 `No agents yet` 等 muted 提示。
- **视觉**：大量留白、无 card 边框、hover 仅背景色变化、选中指示单一且克制。

### 右侧边栏
- **标题**：`Open Tabs` 作为区标题。
- **工具切换列表**：图标 + 名称的垂直列表（Changes / Browser / Terminal / Files），用于切换当前激活的工具面板。
- **状态反馈**：当前激活项高亮，未激活项 muted。

---

## 二、当前天枢 Desktop 的差距

### 左侧
- `Rail` 与 `ProjectSidebar` 视觉上是两个独立 pane，缺乏 Cursor 的连续感。
- `ProjectSidebar` 仍以「线程列表」为核心，没有清晰区分「主导航」与「项目/会话树」。
- 项目切换器是下拉框，而非树形分组。
- 缺少显眼的顶部 `New Session` 按钮。

### 右侧
- `ReviewPanel` 使用 tab 切换（审查 / 方案 / 任务 / PR），与 Cursor 的「Open Tabs 列表」形式差异较大。
- 各 tab 内容堆叠在固定面板内，缺少「列表 → 内容」的分层感。

---

## 三、左侧边栏改造方案

### 3.1 结构重塑

将左侧边栏合并为单一连续视觉区域（保留底层两个 DOM 元素，但视觉上统一）。

```
┌─────────────────────────┐
│  + New Session          │  ← 顶部主操作按钮
├─────────────────────────┤
│  ◇ 工作台               │  ← 主导航（原 Rail 项）
│  ◷ 自动化               │
│  ◉ 需处理  · 3          │  ← badge 提示未读
│  ✦ 技能                 │
│  ⚙ 设置                 │
├─────────────────────────┤
│  HOME                   │  ← 区标题
│  No sessions yet        │  ← 空状态
├─────────────────────────┤
│  ▾ autonovel            │  ← 项目分组头（可折叠）
│    ● Current prompt...  │  ← 项目下会话
│    ○ Tianshu theme...   │
│  ▸ revit                │
│  ▸ Ebook-v1.0           │
├─────────────────────────┤
│  More                   │  ← 更多项目/归档
└─────────────────────────┘
```

### 3.2 组件改造

| 位置 | 当前实现 | 改造方式 |
|------|---------|---------|
| `Rail.tsx` | 56px 图标条，含 brand/导航/主题 | 保持最左侧 56px 图标导航，但将 brand 弱化或上移到窗口标题区；导航项 active 仍使用左侧细线 |
| `ProjectSidebar.tsx` | 项目下拉 + 线程平铺列表 | 改为 Cursor 风格侧栏：顶部 New Session 按钮 + 主导航 + 项目树 |
| 项目数据结构 | `deriveProjects` 返回扁平列表 | 复用现有 projects/sessions 数据，按 `cwd` 分组为树；保留搜索过滤 |

### 3.3 顶部 New Session 按钮

- 样式：与 Cursor 的 `New Agent` 一致，全宽圆角按钮，左侧 + 号，accent 边框/文字。
- 行为：点击打开 `NewSessionDialog`。
- 快捷键提示：右侧显示 `⌘N`。

```tsx
<button className="sidebar-new-btn">
  <span>+</span>
  <span>New Session</span>
  <span className="hint">⌘N</span>
</button>
```

### 3.4 主导航列表

将 `Rail` 中的 surface 导航项搬到 `ProjectSidebar` 顶部（保留 `Rail` 作为最窄图标栏，或可选完全合并）。

- 每个导航项：左侧 16px 图标 + 标签文字 + 右侧 badge（如需处理数）。
- active：左侧 accent 细线 + subtle 背景。
- hover：subtle 背景。

为减少侵入，推荐：
- **方案 A（推荐）**：保留 `Rail` 作为 56px 图标栏，`ProjectSidebar` 内部增加主导航列表。好处是快捷键 Cmd+1..5 仍可用，且最左侧有常驻导航。
- **方案 B**：完全移除 `Rail`，把图标导航整合进 `ProjectSidebar`。更 Cursor，但需要调整全局布局宽度。

### 3.5 项目/会话树

- 将线程按 `cwd` 分组为项目节点。
- 项目节点可展开/折叠，状态 persisted（可选 `localStorage`）。
- 项目头显示 folder icon + 项目名 + 线程数。
- 项目下会话使用 `.thread-row` 样式（已改造），当前会话左侧 accent 线高亮。
- 空状态：`No sessions yet` / `Open a folder or create a session`。

### 3.6 归档与更多

- 将「显示归档会话」从固定底部按钮改为「More」折叠项，或放到项目树底部。
- 减少固定底部 chrome。

---

## 四、右侧边栏改造方案

### 4.1 结构重塑

将 `ReviewPanel` 从 tab 切换改为「Open Tabs 列表 + 内容区」：

```
┌─────────────────────────┐
│  Open Tabs              │  ← 区标题
├─────────────────────────┤
│  ✓ Changes              │  ← 当前激活
│  🌐 Browser             │
│  > Terminal             │
│  📄 Files               │
│  📋 Plan                │
│  ☑ Tasks                │
│  🔀 PR                  │
├─────────────────────────┤
│  [当前选中 tab 的内容]   │  ← 下方内容区
└─────────────────────────┘
```

### 4.2 组件改造

| 当前 | 改造 |
|------|------|
| `ReviewPanel.tsx` 顶部 tab bar | 改为左侧/上方 `Open Tabs` 垂直列表 |
| `review-tabs` / `review-tab` | 重命名为 `tool-tabs` / `tool-tab`，样式改为扁平列表项 |
| tab 内容区 `review-body` | 保持，但布局调整为「列表在上/左，内容在下/右」或「列表即切换器，下方渲染内容」 |

### 4.3 视觉风格

- `Open Tabs` 标题：muted、uppercase、小字号、letter-spacing。
- 列表项：图标 + 名称，右侧可带 badge（如待审数量、任务数）。
- active：左侧 accent 线或背景高亮。
- hover：subtle 背景。
- 内容区：与当前一致，但减少 section 边框，增加留白。

---

## 五、具体文件修改清单

### React 组件
- `desktop/src/components/Rail.tsx`
  - 弱化 brand；保持图标导航；active 样式已改造，可继续微调。
- `desktop/src/surfaces/ProjectSidebar.tsx`
  - 新增 New Session 按钮。
  - 新增主导航列表（复用 surface store）。
  - 将线程列表改为按项目分组的树。
  - 简化归档区。
- `desktop/src/surfaces/ReviewPanel.tsx`
  - 将 tab bar 改为 Open Tabs 列表。
  - 调整内容区布局。

### CSS
- `desktop/src/styles.css`
  - 新增 `.sidebar-new-btn`、`.sidebar-nav`、`.sidebar-nav-item`、`.project-tree`、`.project-tree-header`、`.project-tree-chevron`、`.open-tabs`、`.tool-tab` 等样式。
  - 调整 `.project-sidebar` padding/spacing 以匹配 Cursor 的宽松节奏。
  - 调整 `.review` 布局为列表+内容双层。
- `desktop/src/styles/tokens.css`
  - 可能需要新增 `--sidebar-width` token（当前 264px 可保留或略增到 280px）。

### 测试
- `desktop/src/lib/__tests__/projects.test.ts`（如分组逻辑变化）。
- 新增/更新 ProjectSidebar / ReviewPanel 相关测试（当前 desktop 测试以 lib 为主，UI 组件测试较少）。

---

## 六、数据与状态改动

- 复用现有 `useUiState` 的 `surface`、`activeProject`、`openTabs`。
- 项目树展开状态：新增组件级 state 或 `localStorage` 持久化（可选 P2）。
- 右侧 tab：将 `ReviewTab` 状态与 UI store 解耦或保留组件级 state 均可。

---

## 七、实施优先级

### P1：左侧核心改造
1. ProjectSidebar 顶部 New Session 按钮。
2. ProjectSidebar 主导航列表（复用 Rail surface）。
3. 线程按项目分组为树。

### P2：右侧改造
4. ReviewPanel tab → Open Tabs 列表。
5. 内容区布局微调。

### P3：细节打磨
6. 图标统一、间距精调、动画过渡。
7. 空状态文案 Cursor 化。
8. 快捷键 hint 显示。

---

## 八、风险与回滚

| 风险 | 缓解 |
|------|------|
| 布局宽度变化导致内容区过窄 | 保持 sidebar 宽度 264–280px，最小窗口 900px 足够 |
| 项目树折叠状态丢失 | 先使用组件 state，后续再加 localStorage |
| ReviewPanel 内容区高度变化 | 保持 flex 布局，列表 fixed 高度或 scrollable |
| 测试覆盖不足 | 改造后补 snapshot / 渲染测试 |

---

## 九、验收标准

- [ ] 左侧边栏顶部有显眼的 New Session 按钮，带 ⌘N hint。
- [ ] 左侧主导航包含工作台/自动化/需处理/技能/设置，active 项有左侧 accent 线。
- [ ] 线程按项目分组为可展开树，当前会话高亮。
- [ ] 右侧边栏显示 Open Tabs 列表，点击切换内容面板。
- [ ] 类型检查通过：`cd desktop && npm run typecheck`
- [ ] 测试通过：`cd desktop && npm test`
- [ ] 无未提交的 `.rivet/` / `docs/` 运行时文件。
