# ANSI TUI 差异化可能性

> 日期：2026-06-17 · 状态：探索完成，待后续落地 · 前置讨论：Ink 退役根因分析

## 背景

天枢 TUI 已从 Ink 6（React TUI）迁移到纯 ANSI 自绘引擎（T9）。Ink 退役的根因不是"用得不好"——Ink 的 `<Static>` 组件与"前缀可能漂移的动态历史数组"存在结构不兼容，Claude Code（React 19 重写渲染器）和 Gemini CLI（alt-screen 一周回滚）碰到了同族问题。

纯 ANSI 给了我们 Ink 拿不到的三个底层自由度：
1. **对终端硬件的直接控制** — 任意 ANSI escape sequence、DEC 私有模式
2. **无框架中间层的渲染时序** — 无 React reconciler、无虚拟 DOM diff
3. **scrollback 原生语义的掌握** — CommitEngine 直接 `stdout.write`，知道每一行何时物理进入终端历史

---

## 已有资产

当前 T9 ANSI 架构（`src/tui/engine/`）：

| 模块 | 职责 | 文件 |
|------|------|------|
| CommitEngine | append-only stdout 写入终端 scrollback | `commit-engine.ts` |
| LiveEngine | display-row-aware 增量重绘底部 live 区 | `live-engine.ts` |
| TuiApp | 主事件循环，协调 engine + 6 个 controller | `app.ts` |
| ANSI 工具库 | 原始 escape sequence + 类型安全构建器 | `ansi.ts` |
| BlockStreamWriter | 流式文本缓冲 + 段落/句末/硬上限切分 | `../block-stream-writer.ts` |
| StreamRenderer | 流式输出 commit-prefix / live-tail 分屏 | `stream-renderer.ts` |

已有 ANSI 能力：CSI 2026 同步输出、cursor save/restore、行擦除、24-bit color、RingBuffer scrollback

---

## 差异化可能性清单

### 一、scrollback 作为一等公民

**1. 流式 progressive commit（aider 模型增强版）**

当前：流式内容全部留在 live 区，turn 末才一次性进 scrollback。长回复（500+ 行）时 live 区超视口 → 滚屏/闪烁。

方案：流式时在语义边界（markdown 段落闭合、代码围栏平衡、表格分隔行到位）将已确定的前缀 commit 进 scrollback，live 区只保留可变尾段。尾段设硬上限（~0.5× 视口高）兜底。

- 竞品对照：aider 逐 6 行 commit（无 markdown 感知），Claude Code 只在 turn 末 commit（有同类滚屏 bug）
- 涉及文件：`block-stream-writer.ts`、`stream-renderer.ts`、`CommitEngine`、`LiveEngine`
- 参考：`docs/superpowers/specs/2026-06-06-conversation-render-architecture-design.md`

**2. scrollback 内超链接（OSC 8）**

已 commit 进 scrollback 的每一行可带 ANSI 超链接：文件路径 → `file://`，issue → GitHub URL，工具调用结果 → 可点击跳转。OSC 8 支持度已很高（iTerm2、WezTerm、Windows Terminal、Konsole）。

- 竞品对照：几乎没有 AI coding agent 在用——Ink 把输出抽象成组件树，超链接需手动拼接 ANSI 绕开框架
- 涉及文件：`CommitEngine`、各类 `format/*.ts` 输出函数

**3. scrollback 不可变的 rewind 语义**

rewind 后旧内容已在物理 scrollback 中，打分隔线继续往下写——用户可同时看到回退前后的内容，不会被覆盖。Ink 的 `<Static>` index + RingBuffer 交互对此是已知雷区。

- 涉及文件：`CommitEngine`、rewind 逻辑

### 二、终端硬件能力直达

**4. 行级 diff 重绘（LiveEngine 深化）**

当前 `LiveEngine` 已是 display-row-aware 增量重绘。下一步：流式输出时 diff 的是 ANSI 格式化后的显示行，而非文本内容——一行只多了两个字就只重写那一行。Ink 的 `createIncremental` 做同类事但多一层 reconciler 开销。

- 涉及文件：`live-engine.ts`

**5. DECSTBM 底部固定栏**

设置 scrolling region 把输入行/GlanceBar 钉在屏幕底部不可滚区域。终端硬件级保证——不管上面滚多少行，底部 N 行纹丝不动。Ink 用 flexbox 模拟，resize 或超屏时易漂移。

- 涉及文件：`LiveEngine`、`ansi.ts`

**6. 终端通知（OSC 9 / OSC 777）**

长时间工具执行完成 → 桌面通知。iTerm2、WezTerm 支持。Ink 碰不到这个层级。

- 涉及文件：`ansi.ts`、工具执行回调

**7. 条件性终端能力自适应**

检测 Sixel/Kitty/iTerm2 图片协议、CSI 2026、OSC 8、true color，按能力降级。`ansi.ts` 作为单一 ANSI 出口，加能力探测不散落。

- 涉及文件：`ansi.ts`、`LiveEngine`、`CommitEngine`

### 三、认知层可视化（天枢独有）

**8. 星域实时状态指示器**

当前 GlanceBar 里星域是静态文字。可做动态过渡：星域轮换时 ANSI 颜色渐变，工具调用与星域关系可视化（"瑶光域正在审查你的代码"）。

- 涉及文件：`format/glance-bar.ts`

**9. cognitive-mirror 微型仪表盘**

vigor / strategy / effort / theta 用 ANSI 颜色微型条形图或 sparkline 展示在 GlanceBar。用户一眼感知 agent 的"疲劳度""激进程度"。

- 涉及文件：`format/glance-bar.ts`、`sparkline.ts`

**10. 子 agent fleet 实时面板**

类似 htop 进程列表的 mini fleet view：每行一个 worker 状态（running/done/error），带耗时和文件计数。纯 ANSI 每帧重画几行，无 React 组件树开销。

- 涉及文件：`format/worker-fleet.ts`、`LiveEngine`

### 四、信息密度与克制

**11. 语义着色系统**

工具调用结果按严重度/类型自动着色：错误红、警告黄、成功暗色（不抢注意力）、文件操作青、网络请求洋红。在写入 scrollback 前做语义标注。

- 涉及文件：`format/tool-card.ts`、`format/tool-domain.ts`、`CommitEngine`

**12. 自适应渲染策略**

终端宽度 < 80 列 → 自动精简 GlanceBar、折叠工具卡片。CI/非 TTY → 关闭所有 ANSI、纯文本输出。

- 涉及文件：`LiveEngine`、`ansi.ts`、各 format 模块

---

## 三条差异化路线（按投入排序）

### A. 低成本高感知（1-2 周）

scrollback 超链接 + 语义着色 + 终端通知 + GlanceBar sparkline

不改核心架构，只在现有 format 模块和 CommitEngine 上加 ANSI 修饰。用户立刻能感知差异。

### B. 中投入结构升级（3-4 周）⭐ 推荐最优投入点

progressive commit + DECSTBM 固定栏 + mini fleet view

改变渲染时序，触及 `block-stream-writer.ts` 和 `LiveEngine`。解决真实用户面前的"长回复滚屏"问题——这是 Claude Code 同款未修 bug。DECSTBM 是纯 ANSI 能轻松做到但 Ink 做不到的小甜点。

### C. 大投入架构演进（6+ 周）

行级 diff 重绘 + 终端能力自适应 + 全量 cognitive dashboard

重写 `LiveEngine` diff 策略、加终端探测层、重新设计 GlanceBar 布局。"面向世界"的长期投资。

---

## 关联文档

- `docs/superpowers/specs/2026-06-06-conversation-render-architecture-design.md` — progressive commit 架构设计（含 R1-R6 修订意见）
- `docs/superpowers/specs/2026-06-05-conversation-render-architecture-design.md` — 五方案演化记录（已作废，保留考古）
- `docs/known-issues/tui-duplicate-render-and-scroll.md` — Ink 双真凶诊断
- `.rivet/plans/mid-tui-engine-app分解-ink退役.md` — Ink 退役 + T9 controller 抽取计划
- `docs/desktop-render-perf-audit.md` — 桌面端渲染性能审查
- `docs/research/2026-06-17-claude-code-agent-tool-mechanism-analysis.md` — Claude Code 竞品分析

---

## 后续步骤

1. 从 B 路线切入，先出 progressive commit 的轻量实施计划
2. DECSTBM 探针验证（先确认主流终端兼容性：iTerm2 / WezTerm / Windows Terminal / tmux）
3. A 路线的超链接和语义着色可作为 B 的中间站顺手做
