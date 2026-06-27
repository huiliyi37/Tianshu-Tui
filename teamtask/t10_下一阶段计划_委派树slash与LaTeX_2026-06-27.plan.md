# 下一阶段计划：委派树可视化、Slash 命令、LaTeX 渲染

> 目标：把天枢桌面端的「可观测性」和「输入效率」再推一级，承接已交付的 Insights 面板与 Composer 语音输入。
> 预计工期：4–6 个工作日（1 人）。

---

## 0. 背景与边界

- 不改 runtime 内核、不动 prompt/cache 不变量。
- 只动 `src/server/` API 面、`desktop/src/` UI 面、以及必要的共享类型。
- 复用现有产物：`DelegationTree.tsx`、`event-reducer` 的 delegation 状态、`resolveAppPromptInput`（TUI slash 解析）。

---

## 1. 委派树可视化（Delegation Tree Surface）

### 现状
- 后端 `onDelegationActivity` 已 emit `delegation` 事件，带 `parentId`。
- 前端 `event-reducer` 把 delegation 事件聚合为 `delegation: Record<string, DelegationNode>`。
- 已存在 `desktop/src/components/DelegationTree.tsx`（可能只做了基础渲染）。

### 目标
- 新增 `desktop/src/surfaces/DelegationSurface.tsx`，作为独立的 surface 入口。
- 以树状结构展示一次父级 tool 调用派生出的所有子代理：
  - 根节点 = 触发 delegator 的 tool id
  - 子节点 = worker
  - 边表示父子关系
- 每个节点展示：profile、status、model、provider、cost、elapsedMs、progressLine。
- 点击/悬停节点显示右侧详情面板（复用 Insights 的 cost/token 格式化函数）。
- 节点状态用颜色：running/passed/failed/blocked/escalated。

### 关键改动
1. `desktop/src/state/store.tsx`：新增 `delegation` surface（如果还没加）。
2. `desktop/src/App.tsx`、`Rail.tsx`、`ProjectSidebar.tsx`：注册导航入口 + Cmd+1..8 + Command Palette。
3. `desktop/src/surfaces/DelegationSurface.tsx`：
   - 从 `useUiState().delegation` 取数据
   - 按 `parentId` 构建树
   - 支持折叠/展开、按 status 过滤
4. `desktop/src/components/DelegationTree.tsx`：增强渲染（缩进线、icon、cost badge）。
5. `desktop/src/styles.css`：树形布局样式。

### 验收
- 一次 `/team` 或 `delegate_batch` 调用后，打开 Delegation Surface 能看到完整树。
- 节点上显示的成本/模型与 Insights 面板一致。

---

## 2. Composer Slash 命令

### 现状
- TUI 端 `src/tui/slash-commands.ts` 已实现了 `/plan`、`/team`、`/council`、`/review`、`/write-plan`、`/goal` 等解析。
- 桌面端 `Composer.tsx` 目前只支持纯文本 + 语音输入，没有 slash 提示。
- `session-routes.ts` 的 `POST /sessions/:id/prompt` 已调用 `resolveAppPromptInput`（说明后端 slash 解析已可用）。

### 目标
- 桌面 Composer 输入 `/` 时弹出 slash 命令补全菜单。
- 显示命令名、描述、示例。
- 选择后把结构化 prompt 注入输入框或直接发送。
- 与 TUI 行为对齐：未识别 slash → 拒绝并提示。

### 关键改动
1. 把 `src/tui/slash-commands.ts` 的解析逻辑抽成共享模块，或直接在桌面复用：
   - 选项 A：移动 `resolveAppPromptInput` 到 `src/shared/slash-commands.ts`（推荐）。
   - 选项 B：桌面端单独实现一份（维护负担大）。
2. `desktop/src/components/Composer.tsx`：
   - 监听 `/` 触发补全
   - 渲染悬浮命令列表（方向键选择、Enter 确认、Esc 关闭）
   - 选择后替换输入框内容
3. `desktop/src/styles.css`：slash 菜单样式。

### 验收
- 输入 `/plan` 显示计划相关命令。
- 选择 `/team` 后发送的是已解析的结构化 prompt（可观察 network 或后端日志）。
- 未知 slash 不会误发，提示用户。

---

## 3. Markdown LaTeX 渲染

### 现状
- 桌面 `Markdown.tsx` 使用 `react-markdown + remarkGfm`。
- TUI 端刚移植了 `latex-to-unicode` 和 `latex-block`（终端渲染）。
- 桌面端模型若在思考/回复中输出 `$...$` 或 `\[...\]`，显示为纯文本。

### 目标
- 桌面 Markdown 支持行内数学 `$...$` 和块级数学 `$$...$$` / `\[...\]`。
- 使用 `remark-math` + `rehype-katex`（或 `react-katex`）。
- 安全：只渲染数学，不禁用 HTML 转义。

### 关键改动
1. `desktop/package.json`：新增依赖 `remark-math`、`rehype-katex`、`katex`。
2. `desktop/src/components/Markdown.tsx`：
   - 引入 `remarkMath` 和 `rehypeKatex`
   - 注入 KaTeX CSS（可从 CDN 或本地 bundle）
3. `desktop/src/styles.css`：KaTeX 暗黑/亮色主题变量适配。

### 验收
- 在会话中输入包含 `$$E=mc^2$$` 的回复，桌面正确显示公式。
- 未破坏现有 Markdown / GFM 渲染。

---

## 4. 任务顺序与依赖

| 天数 | 任务 | 依赖 |
|---|---|---|
| D1 | 抽离 slash 命令解析为共享模块；桌面 Composer slash 补全 UI | 无 |
| D2 | slash 命令与后端 `/prompt` 联调；写测试 | D1 |
| D3 | Delegation Surface 树构建 + 节点渲染 | Insights 已交付 |
| D4 | Delegation Surface 导航接入 + 详情面板 + 样式 | D3 |
| D5 | Markdown LaTeX 接入 + 样式 | 无 |
| D6 | 回归测试：桌面 typecheck/test + 实跑验证 | 全部 |

---

## 5. 风险与预案

| 风险 | 预案 |
|---|---|
| `resolveAppPromptInput` 依赖 TUI 专用上下文 | 拆分时只保留纯解析函数，移除对 `uiState` / `record.cwd` 外的依赖 |
| 委派事件 `parentId` 不完整导致树断裂 | 对缺失 parentId 的节点做 orphan 根处理；后续补充 coordinator 保证 parentId 透传 |
| KaTeX 体积大 | 按需从 CDN 加载 CSS，不打包进首屏 chunk |
| slash 菜单与输入法冲突 | 只在输入框获得焦点且无前导空格时触发 |

---

## 6. 不做的范围

- 不碰星域/议事会（I1，属于天枢最大差异化，需单独一个阶段）。
- 不碰自动更新/签名/跨平台打包（偏 DevOps，可并到发布阶段）。
- 不改 runtime 内核、不改 AgentLoop。
