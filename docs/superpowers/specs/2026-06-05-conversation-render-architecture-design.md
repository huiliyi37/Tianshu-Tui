# 天枢 TUI 会话渲染架构 深度头脑风暴结果

**日期:** 2026-06-05
**主题:** 真凶②(流式失控滚屏)的最优架构方案 —— 面向全世界用户的稳定会话界面
**方法:** deep-brainstorm 三轮演化(变异→选择→适应)+ 5 路 scout 证据
**状态:** 设计完成,待用户审查 → 之后 writing-plans 出实施计划。**本会话因安全分类器间歇故障无法跑 typecheck/test,实现+验证留给后续。**

---

## 背景

### 用户需求(原话)
> 对真凶2的方案进行讨论和设计,找最优的方案而不是最小补丁的方案。天枢tui会面向世界所有人,不要做成个不稳定的会话面板。使用5个scout探查怎么做好这个会话界面。

关键约束:**最优非补丁、面向世界(所有终端环境)、不能不稳定**。

### 项目上下文
- 天枢/rivet = React + Ink 6 的终端 AI coding agent。
- 真凶②(失控滚屏)+ 真凶①(重复渲染)源诊断见 `docs/known-issues/tui-duplicate-render-and-scroll.md` 与本日交接文档 `HANDOFF-2026-06-05-steer-and-render-fixes.md`。
- 记忆 `dynamic-budget-was-a-layout-workaround`:用户明确**反对行预算(per-row budgeting)**,认为正解是布局。

### 调研发现摘要(5 路 scout)
- **竞品**:Claude Code = 自研 React19 渲染器(在 Ink 上重写),双模式(默认 inline+scrollback / `/tui` alt-screen);**它自己也有同款 bug** —— [#52020 重复文本](https://github.com/anthropics/claude-code/issues/52020)(=真凶①)、[#17529 resize 重渲整个会话](https://github.com/anthropics/claude-code/issues/17529)、[#42002](https://github.com/anthropics/claude-code/issues/42002)/[#39315 alt-screen 杀 scrollback](https://github.com/anthropics/claude-code/issues/39315)。
- **黄金标准**:[`@mariozechner/pi-tui`](https://badlogic-pi-mono.mintlify.app/tui/overview)(45k★,TypeScript)—— 行级差分渲染 + **CSI 2026 同步输出**原子刷新;三策略(首渲全输出 / resize 全清重画 / 常规仅改变行)。
- **[Signature Flicker](https://steipete.me/posts/2025/signature-flicker)**:Ink "不支持长时交互 UI 所需的细粒度增量更新";alt-screen 破坏选择/scrollback/搜索 → **Gemini 一周内回滚**;差分渲染才是正解,Anthropic 保留 React 组件模型重写了渲染器。
- **[/tui 仪表盘模式](https://amanparmar3.substack.com/p/claude-code-for-everything-your-terminal)**:alt-screen 解决闪屏+钉输入+内存平,但代价是 Cmd+F 搜不到、scrollback 丢失(需 `Ctrl+o` transcript 模式补救)。
- **事实层**:`logUpdate` 只能擦它上次渲染的高度;alt-screen 按 xterm 规范无 scrollback;CSI 2026 非普遍支持(老终端忽略但可优雅降级)。

---

## 核心洞察(对抗性 scout 的关键反转)

> **真凶① 与 真凶② 是同一个架构缺陷**:committed scrollback(`<Static>`)与 live 区之间的边界不可靠。

并且:**记忆 #43 的"布局单独解决滚屏"是必要不充分**。Ink Yoga 用 `height={termRows}` + `overflow:hidden` 会裁掉过高流式正文的**底部(最新 token)= 裁错端**。布局能钉输入、能 bound 整帧,但**不能** bound 比屏幕高的流式正文 —— 那需要独立机制(progressive commit)。

最强适应点:**让 live 区结构性有界** —— 完成的行实时滚入原生 scrollback,live 区只持有进行中的尾段。这样 `logUpdate` 永远不需擦超过几行,真凶② **从构造上不存在**,且**不需要替换 Ink、不需要行预算**。

---

## 五个候选方案(第一轮变异)

| 方案 | 生态位 | 一句话核心选择 | 结局 |
|------|--------|----------------|------|
| V1 | 主流 | 修对 inline+Static 布局(根 height=termRows + flexGrow + 输入钉底,无行预算) | **存活·互补** |
| V2 | 邻近 | alt-screen 仪表盘(接管屏幕,只渲可见区,自建滚动) | **灭绝(作默认)→ 降级为可选模式** |
| V3 | 空位 | 差分行渲染器(pi-tui 模型,替换 logUpdate) | **灭绝(纯形态)→ 回收行 diff + CSI2026** |
| V4 | 空位 | 能力自适应多策略(探测 TTY/CSI2026/alt-screen → 分支) | **存活·面向世界层** |
| V5 | 突变 | live 区构造性有界(完成行 progressive commit 进 scrollback,live 只留尾段) | **最强竞争者** |

## 灭绝记录(第二轮选择)

- **V2 作默认 灭绝** —— 破坏原生 scrollback/选择/搜索,与"面向世界"硬约束正面冲突。实证:Gemini 一周回滚、iTerm2 tmux-CC 不兼容、[Windows 乱码 #59145](https://github.com/anthropics/claude-code/issues/59145)、[SSH 降级 #61569](https://github.com/anthropics/claude-code/issues/61569)。**回收**:可选 alt-screen 模式(power-user 开关)+ "只渲可见区→内存平"洞察(改用 scrollback commit 达成)。
- **V3 纯形态 灭绝** —— 替换 Ink 渲染器的重写风险超出小团队。**回收**:CSI 2026 同步输出(低成本抛光)+ 行级 diff 洞察(靠 V5 缩小 live 区,Ink 现有 reconciler 自然够用)。

## 最终方案:单一「committed-scrollback ↔ 有界-live」渲染模型

1. **`<Static>` = 单调追加的 committed 行流**(修真凶①,不替换 Ink)—— 废弃 `ref−length` 相减,改真正只增不改前缀的追加数组。
2. **live 区 = 仅进行中尾段**(修真凶②,无行预算)—— 流式时完成行 progressive commit 进 scrollback。
3. **布局** = 根 `height=termRows` + flexGrow live 区 + 输入 `justifyContent=flex-end` 钉底,移除无效 spacer。
4. **CSI 2026 同步输出抛光 + 能力自适应** —— 支持则原子刷新,非-TTY/CI→纯 append 无 ANSI,老终端/窄屏优雅降级。
5. **可选 alt-screen 仪表盘**作为开关(类 `/tui`),**非默认** —— 保住面向世界的原生 scrollback/选择/搜索。

收敛验证:V1、V5、甚至 V2 的"只渲可见区"都收敛到同一核心真相 → **live 区必须结构性有界;committed 内容归原生 scrollback**。多方案收敛 = 非局部最优。

---

## 实施路径(第三轮适应)

### Phase 1 — 地基:修真凶①,使 progressive commit 安全(前置)
- **动作**:把 `<Static>` 输入改成真正单调追加数组(committed 行只增不改前缀);废弃 `ref−length` 相减;`pushStatic` 的 `ref++` 与 `buffer.push` 锁步。
- **产出**:重复渲染消失;Static 数组前缀稳定。
- **成功标准**:5000+ 消息长会话 + 迟到 tool-result + 多 turn,零重复;ring buffer 回绕正确。
- **退出条件**:若单调数组与 rewind 重置无法调和,退回 `ref↔buffer` 锁步最小修法(见交接文档真凶①方案 A)。

### Phase 2 — 核心:修真凶②,live 区构造性有界 + 布局钉底
- **动作**:流式时完成行 progressive commit 进 Static;live 区(`StreamOutput`)只保留进行中尾段;根 Fragment→`<Box height={termRows}>`,动态区 flexGrow + 输入 `justifyContent=flex-end`,移除无效 spacer。**无行预算**。
- **产出**:失控滚屏从构造上消失;输入钉底。
- **成功标准**:终端 24/40/120 行下,流式 500 行回复,终端不持续滚屏、输入不动、scrollback 完整可搜可选。
- **退出条件**:若 progressive commit 在某终端撕裂,回退到"turn 完成时一次性 commit + live 区显示尾部"。

### Phase 3 — 抛光 + 面向世界
- **动作**:CSI 2026 同步输出包裹帧写入(支持则原子刷新,否则 no-op);扩展能力探测矩阵(非-TTY/CI→纯 append;老终端/窄屏降级);可选 alt-screen 仪表盘开关(非默认)。
- **产出**:闪屏抛光;全终端可用;高级用户可选钉死仪表盘。
- **成功标准**:tmux / SSH / VS Code 终端 / Windows Terminal / CI 管道 各跑流式长回复均稳定;CSI2026 在 kitty/wezterm 生效、老终端无害降级。
- **退出条件**:alt-screen 模式若在 iTerm2 tmux-CC 等乱码,标注限制并默认关闭。

---

## 风险与应对(脆弱点)

| 脆弱点 | 应对 |
|--------|------|
| progressive commit 依赖真凶① 先修(顺序耦合) | 严格分阶段,Phase 1 不绿不进 Phase 2 |
| CSI 2026 / alt-screen 跨终端差异 | 能力探测 + 优雅降级 + 默认走最兼容路径(inline+scrollback) |
| 本会话无法验证(分类器故障) | 设计文档交付,实现+验证留 writing-plans;每阶段带回归测试 |
| 单调 Static 与 rewind 重置冲突 | Phase 1 退出条件已备最小修法 |

## 扩展适应(复用已有资源,零新基础设施)
- `supportsAnsiEscapes` / `shouldUseStaticHistory`(app.tsx:1337)→ 扩展为 Phase 3 能力探测矩阵地基。
- `RingBuffer` + `RenderBatcher`(coalesce)→ 复用为 progressive commit 的批处理通道。
- 现有 `totalItemsPushedRef` 相减模型 → **废弃**,由单调追加数组替代(从根消除前缀漂移)。

## 下一步(Phase 1 第一个具体动作)
读 `src/tui/app.tsx` 的 `staticItemsForInk` useMemo 与 `historyBufferRef`(RingBuffer),设计单调追加数组如何替代 `ref−length` 相减,并确认 rewind 路径如何重置 —— 然后写 Phase 1 的 writing-plans 实施计划。

