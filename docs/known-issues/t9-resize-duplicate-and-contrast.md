# TUI 重复渲染（resize reflow）+ 工具输出对比度 — 已修复

**状态:** ✅ 已修复
**修复日期:** 2026-06-11(t9-ui-refactor 分支)
**涉及文件:** `src/tui/engine/live-engine.ts`、`src/tui/engine/resize-handler.ts`、
`src/tui/format/tool-card.ts`、`src/tui/format/glance-bar.ts`

阿敏在旧 Ink 引擎修过同类「ghost/重复」(`9fafb4e/0395454/e77f774` 等),T9 纯
ANSI 引擎重写后**回归**。以下是 T9 引擎下的根因与修复。

## 问题 1：resize 后 chrome/面板多份不同宽度叠屏(重复渲染主因)

### 症状
终端 resize 后,GlanceBar / 任务面板 / 输入框在 scrollback 里留下多份**不同
宽度**的副本(截图实证:任务面板 `(provider/config/compact/api)` 全宽、半截、
`(...c…)` 截断 三份同屏)。

### 根因
`LiveEngine.render()` 用**当前** `stdout.columns` 算 `rowsForLine`,但
`lastDisplayRows` 是上一帧在**旧宽度**下存的。终端 resize 会把已绘 live 内容按
新宽 reflow → 屏上实际行数变了;而 `moveToTop(lastDisplayRows)` 仍用旧行数 →
cursorUp 量不足 → reflow 后的顶部行擦不掉 → 残留进 scrollback。
`resize-handler.ts` 旧注释"T9 不再需要 clear workaround"是**说谎注释**,掩盖了此回归。

### 修复
`LiveEngine` 新增 `lastColumns` + `reconcileWidth()`:render()/clear() 入口检测
宽度变化,按**新宽度**从 `lineCache` 重算 `lastDisplayRows` 再相对回顶,使回顶量
与终端 reflow 后的屏上行数一致。回归测试见 `live-engine.test.ts` 的
"resize: 宽度变窄后…按新宽度的 reflow 行数回顶"。

> 前提:依赖终端 resize 时 reflow 已绘内容(iTerm2/Terminal.app/kitty/alacritty
> 等主流终端均 reflow)。不 reflow 的终端属极少数边界。

## 问题 2：GlanceBar 状态行溢出换行(次因,见独立文档)

`glance-bar.ts` 的 `stripAnsiLen` 误用 `.length` 而非 display width → CJK 域名把
状态行撑过终端宽 → 末列换行加剧上面的行数错位。详见
[[glance-bar-display-width-duplicate]]。已改用 `string-width`。

## 问题 3：工具输出正文对比度过低(看不清)

### 症状
工具结果正文(`M CLAUDE.md`、文件列表、命令输出)在墨夜底上几乎不可见。

### 根因
`tool-card.ts` 用 `theme.dim`(Tianshu `#494c5b` 远星灰,~2:1 对比度)给正文着色。
`dim` 在 theme 里明确标注"separators / decoration **only**",误用于数据文本。

### 修复
正文改用 `theme.muted`(`#6c6f7e`,~可读对比度);`dim` 仅保留给 `⎿` 连接符等装饰。
回归测试见 `format-tool-diff-thinking.test.ts` 的 "body content uses readable
muted color, NOT decoration-only dim"。

## 不变量(防再回归)
1. **底部 chrome 每行 display width ≤ 终端宽-1**(不溢出换行)。
2. **LiveEngine 回顶必须按当前宽度的 reflow 行数**(reconcileWidth 不可删)。
3. **数据文本用 muted,dim 仅装饰**。
