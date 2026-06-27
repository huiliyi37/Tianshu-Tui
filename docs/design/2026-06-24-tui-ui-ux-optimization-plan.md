# T9 TUI 界面与会话互动优化方案

> 范围：src/tui/ 纯 ANSI 渲染管线、src/main.ts 启动入口、src/tui/theme.ts 主题系统。
> 目标：在保持零 React/Ink 依赖、不破坏现有 ANSI 同步协议的前提下，提升视觉层次、反馈精度与会话互动体验。

---

## 一、现状速览

T9 TUI 是一条成熟的纯 ANSI 渲染管线：

- **主循环**：`src/tui/engine/app.ts` 中 `TuiApp` 统一调度 `CommitEngine`（scrollback）、`LiveEngine`（底部动态区）、`OverlayEngine`（全屏覆盖层）、`InputHandler`（键盘输入）。
- **屏幕布局**：上部为已提交的 scrollback，底部 live region 固定显示 spinner、thinking、streaming tail、工具卡片、审批/意图框、任务列表、GlanceBar、输入框。
- **主题系统**：`src/tui/theme.ts` 定义 12 套主题，默认主题为 `tianshu`（玄夜墨色）。
- **消息样式**：用户消息用 `▌` 标记，助手消息流式渲染并 commit 到 scrollback，工具卡片按工具族分色。
- **交互**：支持 slash 命令、@ 文件补全、vim 模式、steering（流式期按 Enter 入队）、审批/意图确认、overlay（pager、palette、cockpit 等）。

主要优化空间集中在：**默认主题语义色、状态反馈精度、信息密度与可发现性、覆盖层一致性、代码高亮主题一致性**。

---

## 二、设计目标

1. **主题强调色更现代、语义更清晰**：默认主题从「玄夜墨金」调整为更中性的「冷调钴蓝/墨青」，降低用户标记被误读为错误的概率。
2. **运行态反馈更精准**：spinner 文案跟随 phase，不再一律显示 `thinking…`。
3. **视觉层次更分明**：GlanceBar、工具卡片、审批框、输入框的强调层级重新分配。
4. **可发现性提升**：截断工具卡片增加展开提示、overlay 底部 footer 统一、welcome 屏可折叠。
5. **会话互动更顺滑**：steering 队列可视化、审批/意图框视觉隔离、多行输入增加滚动指示。

---

## 三、主题与强调色优化

### 3.1 默认主题调整建议

当前默认 `tianshu` 的 `userColor` 为朱砂赤 `#d4453a`，在终端中红色与错误强绑定，容易让用户消息标记 `▌` 被误读为告警。建议：

**方案 A（推荐）：默认切换为 `cobalt`，并微调强调色**
- 将默认主题 `let activeTheme: ThemeName = 'tianshu'` 改为 `'cobalt'`。
- `cobalt` 本身已是「冷调中性」设计，但可做小幅精修：
  - `primary` 从 `#61aef4` 略微提亮到 `#6ab8ff`，让流式指示/链接在深色背景上更醒目。
  - `secondary` 从 `#8db5e0` 略微偏向青灰 `#9cc3e8`，减少与 `primary` 的色相冲突。
  - `dim` 从 `#8590a0` 降到 `#7a8494`，让分隔符更安静。
- `userColor` 保持冷白 `#e6ecf2`，`assistantColor` 保持冷灰 `#bdc3ca`，不抢 accent。

**方案 B：保留 `tianshu`，但调整用户标记色**
- 如果品牌上希望保留「玄夜墨色」，则将 `userColor` 从朱砂赤改为星金 `#d4a574` 或暖灰 `#c4b8a8`。
- `error` 保持朱砂赤，`pulseAlert` 保持朱砂印，确保错误语义不被稀释。

建议采用 **方案 A**，因为：
- `cobalt` 的冷蓝 accent 更符合现代开发者工具审美（VS Code、JetBrains 暗色主题）。
- 用户标记不抢色、不告警，整体阅读疲劳更低。
- 与桌面端 `tokens.css` 的 `--tui-accent` 可自然对齐。

### 3.2 主题一致性修复

| 问题 | 位置 | 修复 |
|------|------|------|
| `/theme` help 写默认 `cobalt`，实际默认是 `tianshu` | `src/tui/slash-commands.ts:54` | 统一改为实际默认值，或同步改默认主题为 cobalt |
| Markdown 代码高亮色硬编码 | `src/tui/format/markdown.ts:140` 的 `SYN` 对象 | 将语法 token 颜色映射到当前主题：`primary`（关键字/链接）、`secondary`（字符串/函数）、`muted`（注释）、`dim`（标点） |
| 代码块背景/边框不随主题 | `formatMarkdown` 代码块渲染 | 使用 `theme.pulseQuiet` 做背景条、`theme.dim` 做边框 |

### 3.3 强调色使用规范（新增）

建议在 `src/tui/theme.ts` 顶部增加注释规范：

```ts
// 强调色使用规范：
// - primary：    唯一高强调 accent（链接、选中、流式指示、spinner active）
// - secondary：  结构强调（edit/write 头、assistant 正文弱强调）
// - success：    测试通过/完成/归航
// - warning：    注意/委派/stall
// - error：      错误/高风险/上下文近满
// - userColor：  用户消息标记，必须避开 error 色相（不用纯红）
// - assistantColor：助手正文，中性灰白，不抢 primary
// - dim/muted：  元信息/分隔符，层级：muted 用于可读标签，dim 用于装饰分隔
```

---

## 四、界面 UI 优化

### 4.1 状态行（Spinner）

当前 `formatSpinnerStatus` 在所有非 idle phase 都显示 `thinking…`。建议按 phase 显示不同文案与颜色：

```ts
const PHASE_LABELS: Record<SpinnerPhase, string> = {
  idle: '',
  thinking: 'thinking…',
  streaming: 'streaming…',
  analyzing: 'analyzing…',
  waiting: 'waiting…',
}
```

- `thinking` / `analyzing` → `theme.muted`
- `streaming` → `theme.primary`（活跃输出，用 accent 提示）
- `waiting`（等待工具/API/审批）→ `theme.warning`
- `stalled`（10s 无 token）→ `theme.warning` 并闪烁

文件：`src/tui/format/spinner-status.ts`

### 4.2 GlanceBar 信息层级

当前右侧 model/cache/tokens/cost/elapsed 全部用 `muted`，只有 token 满阈值才变色。建议：

| 元素 | 当前 | 建议 |
|------|------|------|
| model 名 | muted | dim（最低层级） |
| cache 命中率 | muted / <50% warning | 有数据时 muted，无数据时显示 `⚡-` |
| token 占用 | 按阈值 warning/error | 保持按阈值变色 |
| cost | muted | cost > 0 时显示为 `theme.secondary`（让用户感知到花费） |
| elapsed | muted | dim，但 stall 时提升到 warning |

文件：`src/tui/format/glance-bar.ts`

### 4.3 工具卡片与截断提示

- 截断行尾增加 `… [Ctrl+O]` 高亮提示，颜色用 `theme.secondary`。
- 进行中的 live 工具卡片在标题右侧显示 spinner 点，替代静态 dim 点。
- 折叠的探索工具聚合行 `formatCollapsedGroupLive` 增加展开计数提示，例如 `+3 hidden · Ctrl+O`。

文件：`src/tui/format/tool-card.ts`、`src/tui/format/collapsed-read-search.ts`

### 4.4 审批 / 意图框视觉隔离

当前审批/意图提示只是 live region 中的普通框线，容易被动态内容淹没。建议：

- 使用**反色条**或**顶部固定条**突出：
  - 审批框：顶部一行 `█ APPROVAL REQUIRED █` 背景色用 `theme.warning`，前景黑/白。
  - 意图框：顶部一行 `█ INTENT PREVIEW █` 背景色用 `theme.primary`。
- 在框体上方空一行，与上方 streaming 内容隔离。
- 按键提示 `[y] approve [n] deny [e] edit` 使用 `theme.secondary` 高亮键位字母。

文件：`src/tui/engine/app.ts` 中 `renderApproval` / `renderIntent` 相关分支

### 4.5 输入框

- placeholder 颜色从当前默认改为 `theme.dim`，减少与正式输入的混淆。
- 多行输入超出视窗时，在顶部/底部缩略提示增加行号，例如 `… 3 lines above` → `… ↑3` / `… ↓5`。
- 当前行号指示：在输入框左侧显示微型行号（可选，窄终端关闭）。

文件：`src/tui/engine/input-line.ts`

### 4.6 Welcome 屏

当前 welcome 约 25 行，每次启动强制展示。建议：

- 首次启动（新项目/无 `.rivet/`）展示完整版。
- 后续启动展示**单行折叠版**：
  ```
  ╭─ 天枢 · model · cwd · session · /help ─╮
  ```
- 增加 CLI 参数 `--skip-welcome` 供脚本/CI 使用。

文件：`src/tui/format/welcome.ts`、`src/main.ts`

### 4.7 Overlay 底部 Footer 统一

| Overlay 类型 | Footer 规范 |
|--------------|-------------|
| 搜索型（palette、history-search） | `Esc cancel  ↑↓ select  Enter run` |
| 浏览型（pager、starmap、chronicle、tasks） | `↑↓/j/k scroll  PgUp/PgDn  q/Esc close` |
| 选择型（domain/model/theme picker） | `←/→ tab  ↑↓ select  Enter apply  Esc cancel` |

统一 footer 颜色为 `theme.dim`，键位字母用 `theme.secondary` 高亮。

文件：`src/tui/format/overlay.ts`

---

## 五、会话互动优化

### 5.1 Steering 队列可视化

当前 streaming 期按 Enter 会将消息入队 `steerBuffer`，但用户只能按 `↑` 取回最后一条，无法看到队列全貌。建议：

- live region 中增加一行 ` steer: 2 queued · ↑ to edit · Enter to send now`。
- 队列最后一条高亮，其余用 `theme.dim`。
- 在 `rewind` overlay 中也可查看/删除 queued 消息。

文件：`src/tui/engine/app.ts` 中 `renderLive` 的 queued 消息段

### 5.2 审批/意图流程增强

- 审批框增加**倒计时自动拒绝**提示（可选，默认不启用），防止用户离开终端后误批准长时间挂起的请求。
- 意图预览 `alternative` 选项在有多条备选时显示编号 `[a] alternative 1/3`，按 `1/2/3` 直接选择。
- 审批 JSON 编辑模式增加语法高亮与错误行提示（至少标红错误位置）。

### 5.3 输入历史与补全

- `@` 文件补全候选列表按**最近修改时间**排序，提升常用文件命中率。
- slash 命令 hint 中，当前选中项用 `theme.primary` 反色条，其余用 `theme.dim`。
- 输入历史支持子串搜索：按 `Ctrl+R` 进入 history-search overlay，已存在，但可在输入框中直接按 `Ctrl+S` 向前搜索。

### 5.4 鼠标/滚轮支持（可选增强）

`src/tui/engine/input-handler.ts` 已能解析 SGR mouse protocol，建议：

- 在 pager 中支持滚轮上下翻页。
- 在 command palette / domain picker 中支持点击选中项。
- 在输入框中支持点击定位光标（需要计算鼠标坐标到字符位置）。

此为**P2**，因为纯键盘路径已较完善，鼠标支持属于锦上添花。

### 5.5 Vim 模式决策

当前 vim 模式仅支持 `i/a/A/I/h/l/0/$/w/b/x/dd`，对 Vim 用户价值有限。建议：

- **短期**：默认关闭 vim 模式，在 `/help` 中明确标注为实验性。
- **长期**：若保留，至少补齐 `cc/C`、`p`、数字重复、`u`、visual 模式基础操作。

---

## 六、实施路线

建议分三阶段实施，每阶段保持可回滚：

### 阶段 1：主题与文案一致性（1-2 天）
- [ ] 修改 `src/tui/theme.ts` 默认主题为 `cobalt`（或按方案 B 调整 `tianshu.userColor`）
- [ ] 修复 `src/tui/slash-commands.ts` `/theme` help 默认文案
- [ ] 将 `src/tui/format/markdown.ts` 的 `SYN` 硬编码颜色映射到主题
- [ ] 更新 `formatGlanceBar` 中 cost/elapsed 颜色层级

### 阶段 2：状态反馈与可发现性（2-3 天）
- [ ] 按 phase 区分 spinner 文案与颜色
- [ ] 工具卡片截断增加 `Ctrl+O` 提示
- [ ] 审批/意图框增加反色顶部条
- [ ] 统一 overlay footer 规范
- [ ] welcome 屏增加折叠逻辑与 `--skip-welcome`

### 阶段 3：互动增强（3-5 天）
- [ ] steering 队列可视化
- [ ] 输入框多行滚动指示/行号
- [ ] @ 补全按最近修改排序
- [ ] 审批 JSON 编辑错误高亮
- [ ] 可选：SGR 鼠标滚轮/点击支持

---

## 七、风险与回滚

| 风险 | 缓解 |
|------|------|
| 主题变更让用户不适应 | 保留 `/theme tianshu` 一键切回；首次启动在 welcome 中提示当前主题 |
| ANSI 颜色在某些终端显示异常 | fallback 主题使用 16 色命名，保持 `chalk.level < 3` 路径可用 |
| LiveEngine 行预算变化导致残影 | 所有修改都通过 `WriteBatcher` + `LiveEngine.render()`，修改后跑 `src/tui/__tests__/engine-*.test.ts` |
| 审批/意图视觉改动覆盖重要信息 | 保持行数不变或增加上限，确保 `LiveEngine.applyRowBudget` 不会截断关键确认行 |

---

## 八、验收标准

- [ ] 启动后默认主题为 `cobalt`（或调整后的 `tianshu`），用户消息 `▌` 不再呈现红色。
- [ ] `/theme` help 文案与实际默认值一致。
- [ ] streaming 阶段 spinner 显示 `streaming…` 并使用 `primary` 色。
- [ ] 截断工具卡片尾部显示 `… [Ctrl+O]`。
- [ ] 审批框顶部有反色条，视觉上与 streaming 内容隔离。
- [ ] overlay footer 统一，不再出现 `q` 在搜索型 overlay 中既是关闭又是查询字符的冲突。
- [ ] 所有相关测试通过：`npm test -- src/tui/__tests__`
