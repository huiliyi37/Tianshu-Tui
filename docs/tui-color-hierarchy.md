# TUI 颜色使用层级规范

> Wave 2 对标改造（2026-07）确立。改 `src/tui/format/` 任何组件的着色前先对照本表。

## 语义 token 分层

| Token | 语义 | 允许的使用场景 | 禁止 |
|-------|------|--------------|------|
| `primary` | 交互焦点 / 活跃指示 | 选中项光标（`❯`）、当前 tab、in_progress 任务、streaming spinner、搜索命中高亮、品牌标识（欢迎屏） | 结构标题、表头、面板标签、元信息 |
| `secondary` | 结构强调 | 面板/分组标题、表头、非选中列表项名称、h4-h6 标题、assistant 结构头 | 正文、焦点指示 |
| `success` / `warning` / `error` | 状态语义（唯一） | 测试通过 / 注意·委派·stall / 错误·高风险 | 装饰用途（"这里想要点绿色"） |
| `dim` | 装饰 / 分隔 | 边框、分隔线、快捷键提示、行号 gutter | 需要阅读的正文（亮背景下更不可） |
| `muted` | 可读的次要信息 | 元信息（耗时/token/路径）、已完成任务、描述文案 | 焦点/状态表达 |
| `assistantColor` | 正文 | assistant 消息正文、无 accent 标题（h2/h3） | — |
| `userColor` | 用户标记 | 用户消息 `▌` 标记（唯一暖点主题里的唯一暖色） | 大面积着色 |
| `toolShell/Edit/Test/Delegate` | 工具族识别 | 工具卡片标题 glyph | 工具卡片正文 |

## 核心纪律

1. **正文零着色**：正文用 `assistantColor`（或不着色），靠 bold/italic 做层次，不靠彩色。
2. **primary 稀缺性**：一屏内 primary 出现的地方应当就是眼睛该去的地方。列表里只有选中行用 primary；面板里只有活跃 tab 用 primary。
3. **状态色语义唯一**：绿=通过、琥珀=注意、红=错误。不得挪作装饰。
4. **亮色主题反转纪律**：亮背景下所有语义色取深档（600-700），dim/muted 用中深灰。新增主题必须过 `theme-system.test.ts` 的白底对比度基线（≥3:1）。
5. **hex 不落 format/ 层**：format/ 组件只允许引用 `theme.*` token，硬编码 hex 是 bug（历史案例：markdown h2 硬编码 `#e6edf3` 在亮色主题下不可读）。

## Wave 2 落地时修正的越级用色

- markdown 表头 `primary` → `secondary`（结构强调，非焦点）
- cockpit 七个面板标题 `primary` → `secondary`（同上；panel rail 的活跃 tab 保留 primary）
- turn 完成摘要的耗时 `primary` → `muted`（元信息；完成 glyph ◆ 保留 primary）
- markdown h2/h3 硬编码 `#e6edf3` → `assistantColor`（Wave 1 顺手修）

## 主题双轨与降级

- truecolor 轨（`chalk.level >= 2`）：hex；level 2 由 `ansi.ts fg()` 现场量化为 xterm-256 最近邻。
- fallback 轨（`chalk.level <= 1`）：chalk 命名色 → 基础 16 色 SGR。
- 自定义主题（`~/.rivet/themes/*.json`）只覆盖 truecolor 轨；fallback 继承 base 主题。
