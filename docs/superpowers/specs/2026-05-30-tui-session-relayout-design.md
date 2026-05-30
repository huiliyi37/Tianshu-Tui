# 会话 TUI 界面优化与布局编排 · 深度头脑风暴结果

> 日期：2026-05-30 · 分支：feat/knowledge-manifest-minimal · 方法：deep-brainstorm（变异 → 选择 → 适应）+ 4-scout 调研

## 背景

### 用户需求
> 「我需要对会话这个 tui 界面进行优化。多个 scout 找优化和布局的编排」

痛点四项全选：**空间布局结构 · 流式过程的可读性 · 信息密度/认知负荷 · 工具输出的呈现**。这意味着是一次整体重排（re-layout），不是局部修补。

### 项目上下文
- Rivet 终端 coding agent，Ink 6 inline 模式（非 alt-screen）。
- 当前会话界面（`src/tui/app.tsx`）：`<Static>` 滚动历史（单列堆叠原始消息流）+ 唯一的底部动态 `<Box>`（GlanceBar 单行 + 按需唤出的 7-panel cockpit overlay）。
- Rivet 已有极丰富的状态空间：8 个 StarPhase、9 个 ActivityPhase、12 个 phase 信号、7 个 cockpit panel、完整 theme 语义色——但呈现层单薄（GlanceBar 只显示 1 个相位字形）。

### 调研发现摘要（4 scout）
- **跨域（认知科学/航空/ICU）**：高频状态固定坐标=扫视肌肉记忆；告警按**行动紧迫度**分级而非主观重要度，仅最高级可打断；前注意特征（颜色/运动/位置）余光并行感知，文字须串行聚焦；主动监控容量 4±1；**静默变化=变化盲视**，重要变化必带运动瞬态；F 型扫视左上锚点 + 渐进披露。
- **竞品（Codex/opencode/Aider）**：主流是**单列流式 + 底部固定栏**（Codex `bottom_pane`，footer 按优先级渐进坍缩）；内容类型用 **gutter 前缀（`›`/`+`/`-`）+ 色 + 字形** 区分而非缩进盒；工具输出**硬阈值折叠**（普通 5 行/用户 shell 50 行/错误优先/快捷键展全文）；opencode 用 `width=42` 右侧侧栏承载常驻信息（占宽代价）。
- **项目代码**：`fluency-policy.ts` 的 `PHASE_STALE_TIERS` 已是 `[info/warn/action]` 三级阈值；`star-event.ts` 有 `PHASE_GLYPHS`/`PHASE_SHORT_LABELS`（8 相位）；`chronicle.getPhaseSegments()` 已存在；`LogEntry` 已有 `checkpoint`/`evidence` type 及渲染器——全部可被扩展适应。
- **定向反证（决定性）**：见下方「关键转折」。

### 关键转折：原方向被事实级反证推翻
初始假设「重构为多层固定常驻状态区」被第 4 个 scout 的反证击穿两条腿：

| 反证发现 | 分类 | 影响 |
|---|---|---|
| Ink inline 模式只有「Static 历史 + 唯一底部动态块」，**不能**做顶部/中部固定区或多层分布坐标（除非切 alt-screen 重写整个渲染层） | **事实** | 杀死所有「多层固定面板」方案 |
| 动态块越高，每个 stream token 到达就 `eraseLines(N)+整块重绘`；高度顶到终端行数触发**全屏 clear**（肉眼闪烁灾难） | **事实** | 底部常驻区必须严格限高 |
| coding agent 用户常「发指令→切走→回来看结果」，不实时盯屏 | **假设→现状** | 前注意/余光/肌肉记忆收益打折；「回看一眼读懂」价值 > 「实时盯屏」 |
| verify/context/safety 本性是「出问题才查」的诊断信息，藏 overlay 可能是对的信噪比设计 | **惯例** | 常驻需逐层证明，不能默认「藏=错」 |

**结论**：优化方向从「加监控面板」扭转到真正有空间的地方——**Static 历史区**（当前只有原始消息流，零结构化锚点）。所有方案限定在 Ink 唯一可动的两个面：Static 历史 + 底部动态块。

## 三轮思考过程

### 第一轮：变异

```
生态位: Ink 6 inline 模式终端 / 开源模型 coding agent / 用户"发指令-切走-回看"为主、偶尔实时盯屏 / 已有丰富状态空间但呈现层单薄
选择压力: ① 切走回来一眼读懂"做了什么/在哪/有没有出事" ② 实时盯屏不漏关键变化 ③ 不引入闪烁/不重写渲染层 ④ 终端窄/矮不崩
已占据: 单行 GlanceBar(底部) + 7-panel cockpit(手动 overlay) + Static 历史单列堆叠
空位: Static 历史只有原始消息流,没有"这一轮做了什么"的结构化可回看锚点

方案:
  V1(主流·借鉴Codex底部栏): 底部动态块强化为两行自适应状态条(第1行相位/cache/cost,第2行活动+紧迫度告警),窄/矮终端渐进坍缩成1行。不碰 Static 历史。
  V2(邻近·内容类型区分): 单列不变,给 Static 历史每类条目(user/assistant/thinking/tool/diff)统一改为"单字符 gutter 前缀+语义色+字形",废弃缩进盒混排。
  V3(空位·turn 结构锚点): 历史里为每个 turn 注入"相位分隔锚点"(git log 式),折叠展示该 turn 的 phase 轨迹+读改文件数+验证结果。
  V4(突变·告警驱动反转): 默认极简(几乎无 UI),只在"需行动"状态出现时弹带瞬态的告警块,最高级才打断。

适应度函数:
  硬约束 = 不重写 Ink 渲染层(不碰 alt-screen) + 底部块限高不触发全屏 clear + 窄/矮终端不崩
  加分 = 切走回看一眼读懂 + 实时盯屏关键变化带瞬态 + 复用已有状态空间
  减分 = 增加常驻噪声 + 每 token 重绘成本上升 + 新增手动唤出步骤
```

### 第二轮：选择

**目标重注入**：用户要的是「会话界面的优化与布局编排」，不是「加监控面板」。

```
因果测试:
  V1: 通过(Codex single_line_footer_layout 已验证)
  V2: 通过(Treisman 前注意 + Codex history_cell 双支撑)
  V3: 通过(git log 心智模型 + 呼应"切走回看"场景)
  V4: 断裂 — 因果前提是"当前界面太满",但反证已指出 GlanceBar 信噪比是有意设计,未过载;砍常驻相位反而让回看用户失去定位能力

落地性(反高概念):
  V1: 第一步=glance-bar 加第二行 contextual footer 接 fluencyStale 分级 → 可执行
  V2: 第一步=render-entry.tsx RENDER_MAP 每类前加 gutter 前缀字符列 → 可执行
  V3: 第一步=loop.ts turn 结束处 pushStatic 一条 type='turn_summary' LogEntry → 可执行
  V4: 第一步=加"安静模式"开关 → 可执行,但是减法不是用户要的"编排"

灭绝: V4 — ① 因果断裂(建立在未验证的"太满"前提) ② 与"优化布局编排"需求反向(要编排不是删除) ③ 机会成本最高,与 V1/V3 对冲
discarded_trait 回收(V4):
  - "告警按行动紧迫度浮现+最高级带运动瞬态打断"(ICU 分级) → 嫁接进 V1 底部第二行
  - "默认折叠/干净" → 嫁接为 V3 turn 锚点的默认折叠态

存活:
  V1 — 优势: 零风险、复用 fluency 分级、服务"回看用户一眼定位"
  V2 — 优势: 前注意原理+竞品验证双支撑,解决"流式可读性+工具呈现"
  V3 — 优势: 唯一真正动"空间布局结构"的方案,填补 Static 历史结构空白

最强竞争者: V2+V3 组合(历史区) + V1 基座(底部块,吸收 V4 告警瞬态)
  理由: V2 覆盖流式可读性+工具呈现+信息密度,V3 覆盖空间布局结构;二者都作用在 Static 历史(最大空位)且互补

新发现: 三个存活方案恰好覆盖两个唯一可动面的不同维度 —— V1=底部动态块(实时面)、V2=历史内容编码(扫视面)、V3=历史结构锚点(回看面);非竞争而是互补。真正灭绝的是"在 cockpit overlay 加更多常驻面板"这个最初隐含方向。
```

### 第三轮：适应

```
套路清除:
  - 清除"加 dashboard/监控面板"套路(Ink 事实+诊断信息本性双否定)
  - 清除"信息越多越好",改为"按行动紧迫度和注视场景分配呈现层"

扩展适应(已有资源新用途):
  1. fluency-policy PHASE_STALE_TIERS [info/warn/action] → V1 底部 footer 告警分级(吸收 V4 ICU 紧迫度): info灰常驻 / warn黄 / action红+运动瞬态(对抗变化盲视)
  2. theme.toolColor(name) + success/warning/error → V2 gutter 前缀色彩列
  3. star-event PHASE_GLYPHS/PHASE_SHORT_LABELS(8相位) → V3 turn 锚点的相位轨迹(⭐→🔨→⚔️✓)
  4. chronicle.getPhaseSegments() → V3 turn 摘要数据源(已存在,零新增聚合)
  5. LogEntry 已有 checkpoint/evidence type+渲染器 → V3 turn_summary 复用同一 Static 注入机制

具体化(人/场/动/果):
  人: 一个用 DeepSeek 跑 Rivet 的开发者,发完多文件重构任务后切去看文档,5 分钟后切回
  场: Ink inline 终端,Static 历史堆了 6 个 turn,底部动态块,终端 40 行高
  动: 切回时眼睛走 F 型 → 扫历史 gutter 列(V2: ›我说的/◦它想的 dim/▸它做的/+-它改的,靠色+字符分清不读内容) → 看每 turn 折叠锚点(V3: "⭐→🔨→⚔️✓·读5改3·测试通过·2m14s",像翻 git log 定位"第4轮挂了") → 瞥底部两行(V1: deepseek·🔨铸形·78%·$0.42,第二行灰色"editing src/x.ts"=info级没出事)
  果: 切回到"知道现在在哪/出没出事"的时间,从逐条往上读历史(~30s)降到扫 gutter+锚点+底栏(~3s);零新增 overlay 唤出步骤;不重写渲染层

收敛验证: V2(扫视区分)与 V3(回看锚点)收敛到 —— "Static 历史区是最大未开发空位,优化应让历史可扫+可回看,而非加实时面板"。定为核心策略。V1 与其互补(实时面 vs 回看面),作低风险基座。
```

## 最终方案

在 Ink 唯一可动的两个面（**Static 历史** + **底部动态块**）内，按「回看为主、实时为辅」重新编排。全程复用已有的 phase 字形/语义色/fluency 分级/chronicle 数据，**不加 overlay、不碰 alt-screen、不重写渲染层**。

- **历史区（主投资）**
  - **V2 可扫**：`render-entry.tsx` 给 `RENDER_MAP` 每类条目加统一 gutter 前缀列（`›` 用户 / `◦` thinking-dim-italic / `▸` tool / `+`/`-` diff 红绿）+ 语义色，废弃冗余缩进盒。
  - **V3 可回看**：每个 turn 在历史顶部注入一个 git-log 式折叠锚点（相位轨迹 + 读改文件数 + 验证结果），数据取自 `chronicle.getPhaseSegments()` + evidence，默认折叠。
- **底部块（基座）**
  - **V1 + V4 特征**：GlanceBar 下加第二行 contextual footer，接 `fluency-policy` 三级 stale 分级（info 灰 / warn 黄 / action 红+运动瞬态）；加按终端 rows 降级（矮终端坍缩单行，防全屏 clear 悬崖）。

### 实施路径

| Phase | 动作 | 预期产出 | 成功标准 | 退出条件 |
|---|---|---|---|---|
| **1（最小验证 · V2 历史内容编码）** | `render-entry.tsx` 每类条目加 gutter 前缀列 + 复用 theme 语义色；thinking 改 dim-italic；移除冗余缩进盒 | 历史区每行最左是一列语义化 gutter 字符+色 | 不读内容靠 gutter 列分清 4 类条目；窄终端(<60列)不挤断 | 若 gutter 与 markdown 换行/string-width 冲突错位，退回只改色不加前缀 |
| **2（扩展验证 · V3 turn 结构锚点）** | `loop.ts` turn 结束处 `pushStatic` 一条 `type='turn_summary'` LogEntry（数据取 `chronicle.getPhaseSegments()` + evidence）；`render-entry` 加 turn_summary 渲染器，默认折叠一行 | 每 turn 在历史顶部有 git-log 式折叠锚点 | 6-turn 会话靠锚点行定位到「哪个 turn 做了什么/哪个挂了」无需展开 | 若注入耦合进 API messages 破坏 prefix-cache，改为纯渲染层聚合不注入 |
| **3（规模化 · V1 底部双行状态条）** | glance-bar 下加第二行 contextual footer 接 fluency 三级分级（info 灰/warn 黄/action 红+瞬态）；加按 rows 降级逻辑 | 底部 1-2 行自适应状态条，平时显示活动，出事变色+瞬态 | action 级 stale/审批出现时底部有可感知瞬态；终端 <24 行自动坍缩单行不闪 | 若第二行抬高动态块触发全屏重绘闪烁，降级为单行内嵌告警色 |

**最强适应点**：把优化锚定在「Static 历史区」这个被反证暴露的最大空位 + 全程复用已有状态空间，几乎零新增数据管线，纯渲染层重排。

## 风险与应对

| 脆弱点 | 应对 |
|---|---|
| ① gutter 前缀与 Ink markdown 换行/`string-width` 计算冲突导致错位 | Phase 1 退出条件：冲突则退回纯改色不加前缀 |
| ② turn_summary 注入意外耦合进 API messages 破坏 prefix cache | 严格限定 LogEntry 在 TUI 层（不进 `session.getMessages()`），Phase 2 验证隔离性 |
| ③ 底部第二行抬高动态块触发 Ink 全屏 clear 闪烁 | Phase 3 强制按 rows 降级 + 退出条件保底单行 |
| ④ 用户其实想要 opencode 式侧边栏常驻面板 | 需切 alt-screen 重写整个 TUI 渲染层（架构级），不在本方案范围——若确需，单开一轮评估 |

## 下一步

Phase 1 第一个具体动作：在 `src/tui/render-entry.tsx` 的 `RENDER_MAP` 中，为 `user_message` / `thinking_message` / `assistant_message` / `tool` 各自的渲染器最左侧加一个固定宽度的 gutter 前缀列（字符 + 对应 theme 语义色），先验证不与现有 markdown 渲染冲突。


