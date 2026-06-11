# T9 中国风 UI 改造 · 设计 Brief（喂给 Open Design 的基线）

> 2026-06-11 · t9-ui-refactor 分支
> 产品名：**天枢**（北斗第一星本名 · Rivet 的中文身份）
> 对标：Claude Code 的终端交互密度与克制
> 默认主题：**紫微北斗·墨夜**（可切换主题之一）
>
> 用途：本会话 Open Design MCP 工具未注入（daemon 在线但 schema 未加载），需重启 `claude` 后由新会话调用 `create_project → start_run → get_artifact`。本文件是喂给 Open Design agent 的设计基线，重启后直接引用。

---

## 0. 设计原则（来自领航星既定反馈，优先级最高）

1. **改结构，非换色** —— 层级用留白与对齐表达，不靠加颜色。
2. **做减法** —— 单点强调优于满屏堆砌；中文艺术字「天枢」只在欢迎屏出现一次，不复现于会话流。
3. **不要框 / 不要满屏天枢** —— 不画 box-drawing 边框包裹消息；身份符号是锚点不是装饰。
4. **自信陈述正确性** —— 不拿"闪屏预算"挡责；T9 渲染引擎已是 O(1) 增量重绘，符号动画走 WriteBatcher 合并。
5. **符号语义化** —— 五行/北斗符号必须绑定真实运行态，不是纯装饰。

---

## 1. 现状锚点（已在代码里的中国元素，复用而非重造）

| 位置 | 现状 | 改造方向 |
|------|------|---------|
| `src/tui/format/spinner-status.ts` | phase 动词已中文：凝思/书写/运作/候待 | 保留，绑定五行符号 |
| `src/tui/theme.ts` `observatory` | 注释已是「五色星辰/北斗七星/玄色」 | 提升为 `ziwei` 紫微北斗·墨夜 主题 |
| `src/tui/format/glance-bar.ts` | domain 已显示 `❂ 天枢` | 身份锚保留，glyph 体系化 |
| `src/tui/format/welcome.ts` | 精简 3 行文本标题 | 加中文艺术字 logo（克制版） |

**结论**：天枢已有中国风骨架。本任务是把散落元素收拢成一套**自洽的紫微北斗·五行符号系统**，落到主题 + 欢迎屏 + 会话流三处。

---

## 2. 主题系统：紫微北斗·墨夜（默认）+ 可切换

新增 `ThemeName: 'ziwei'`，与现有 pastel/cyberpunk/observatory/midnight/starfield 并列。

调色板（truecolor，深墨底 `#0d0e14` 上的 WCAG AA+）：

```
primary    #c9b8ff  紫微 — 帝星紫，身份/链接/选中
secondary  #8ab4ff  天枢蓝白 — 北斗主序星色，正文强调
success    #7ee7c7  归航青 — 测试通过/完成（对应五行：木/林）
warning    #ffd479  星金 — 注意/委派（对应五行：土/山）
error      #ff8a9b  荧惑赤 — 错误/高风险（对应五行：火）
dim        #5a5f7a  星尘灰 — 分隔/次要
muted      #9aa2b1  远星灰 — 元信息
印章红     #d4453a  朱砂印 — 单点强调（用户标记/重点），仅点缀
```

fallback（16 色终端）：primary=magenta secondary=blue success=cyan warning=yellow error=red dim=gray。

设计意图：墨夜底 + 紫微帝星紫为主色（区别于 starfield 的蓝白主色），印章朱砂红作唯一暖强调点，呼应中国水墨「留白 + 一点朱」。

---

## 3. 五行动态符号系统（绑定运行态）

把 `SpinnerPhase` 与五行一一映射，**单字形随状态流转**，不是装饰满屏。每个状态一个符号 + 一个五行中文字，spinner 用该字形的笔画/相位做动画帧。

| 运行态 | 五行 | 符号 | 中文动词（已有） | 语义 |
|--------|------|------|----------------|------|
| thinking 思考 | 水 ䷜ | `≋` / `◐` | 凝思 | 水流不息、深不可测 |
| streaming 书写 | 火 ䷝ | `✦` / `炎` | 书写 | 火焰跳动、输出涌现 |
| analyzing 工具 | 风 ䷸ | `⚙` / `颷` | 运作 | 风行天下、工具执行 |
| waiting 候待 | 山 ䷳ | `▲` / `岳` | 候待 | 山止不动、等待审批 |
| done 完成 | 林/木 ䷲ | `❧` / `森` | 归航 | 木生发、回合收束 |

**实现约束**：
- 符号动画走 `writeBatcher.schedule()`（已有，见 commit 7f3b487），不直接 renderLive，避免刷屏。
- 五行字形只在 spinner-status 行 + GlanceBar phase zone 出现，**不进会话正文**。
- 提供 ASCII fallback（无 truecolor / 不支持 CJK 宽字符的终端）：水=`~` 火=`*` 风=`>` 山=`^` 林=`Y`。

---

## 4. 中文艺术字欢迎屏（克制版）

替换 `formatWelcome` 当前的 3 行纯文本标题。要求：

- **主锚**：中文艺术字「天枢」二字，用 ANSI 块字符（▀▄█）或精选 figlet-CJK 风格点阵，**仅此一处**。宽度自适应，窄终端（< 60 列）降级为单行 `天枢 Tiānshū`。
- **北斗七星定位**：logo 右侧或下方用 7 个极简星点（`✦ · · ✦ · · ✦`）勾勒北斗勺形，天枢（首星）用印章红 `●`，其余星尘灰。**不画连线、不画框**。
- **元信息行**（保留现状结构）：`<model> · <cwd> · <session>`，muted 色。
- **快捷键行**：`/help · @files · \⏎ newline · Ctrl+C exit`，dim 色。
- 总高度 ≤ 6 行（含 logo），不喧宾夺主。

布局草图（宽终端）：

```
   ███ ███   ███ ███       ✦
    █   █     █  █  █      · · ✦      ← 北斗勺形，天枢=●(朱砂)
   ███ ███   ███ ███    ●· · ✦
   天 枢  ·  Tiānshū                  ← 艺术字 + 罗马音
   deepseek-v4 · ~/app/rivet · a3f2b1c9
   /help · @files · \⏎ newline · Ctrl+C exit
```

---

## 5. 东风风格会话流

水墨「留白 + 层级」驱动，不靠边框：

- **用户消息**：行首印章红标记 `▌`（或 `❯`），缩进对齐；不画框。
- **助手消息**：行首极简星点 `·` 或无标记，纯正文 + markdown，紫微紫做标题/强调。
- **工具卡**：现有 `formatToolCard` 结构保留，工具名用五行/星域色区分（bash/grep=水蓝、edit/write=紫、test=青、delegate=金）；**用缩进 + 色，不用框**。
- **回合摘要**：`✦ Worked for 1m6s · 12.3k in / 890 out`（已有），收束态符号用「林/归航」。
- **分隔**：回合之间用单行留白或极淡 `─`（dim），不用粗线/双线。

---

## 6. 北斗 / 紫微符号语义表（全局一致）

| 符号 | 含义 | 用处 |
|------|------|------|
| `❂` / `●`(朱砂) | 天枢本星 = 身份锚 | GlanceBar domain、欢迎屏首星 |
| `✦` | 主序星 = 活跃/强调 | spinner 书写态、回合摘要 |
| `·` | 远星 = 次要/占位 | 北斗其余星点、idle |
| 北斗勺形 7 点 | 星图 = 启动身份 | 欢迎屏（唯一处） |
| 五行字 | 运行态 = 动态状态 | spinner + phase zone（见 §3） |

**紫微 = 帝星 = 主控身份色（紫）；北斗 = 定位/状态符号。** 二者分工：紫微管"是谁"（色），北斗管"在做什么"（符号）。

---

## 7. 落地清单（重启后执行顺序）

**A. Open Design 视觉稿（先出图对齐审美）**
1. `create_project` 天枢-tui-中国风（紫微北斗·墨夜）
2. `start_run` prompt = 本 brief §2–§6 + "终端 TUI 渲染，等宽字体，深墨底，HTML 模拟终端视图"
3. `get_run` 轮询 → `get_artifact` 拉预览 → 领航星审

**B. 代码落地（审美定稿后，RED→GREEN）**
1. `theme.ts` 加 `ziwei` 主题 + 设为默认（`activeTheme`）
2. `spinner-status.ts` 五行符号 map + ASCII fallback
3. `welcome.ts` 中文艺术字 logo + 北斗星点 + 窄屏降级
4. `glance-bar.ts` phase zone 接五行 glyph
5. 各 format 函数会话流留白/印章红标记
6. `node:test` 覆盖：主题快照、五行 fallback、welcome 窄屏降级、glance phase glyph

**C. 验证**：`npm run typecheck` 零错；改动文件无新增 lint；`npx tsx src/main-ansi.ts` 真实终端目测；全量 TUI 测试无回归。

---

## 8. 给新会话的开场提示（复制即用）

> 继续 t9 中国风 UI 改造。读 `docs/teamtask/t9_中国风UI改造_设计brief.md`。Open Design MCP 已重启注入，先 `list_projects` 探活，再按 brief §7-A 跑 `create_project → start_run → get_artifact` 出视觉稿给我审，审完再按 §7-B 落代码。默认主题紫微北斗·墨夜，原则见 §0（改结构非换色、做减法、不要框、中文艺术字只在欢迎屏一次）。
