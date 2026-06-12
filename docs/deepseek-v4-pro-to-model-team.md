# 天枢技术文档包

> 面向模型团队（DeepSeek / MiMo / GLM）
> 核心定位：CVM — 模型认知增强的运行时层
> 日期：2026-06-12（基于 2026-06-01 原稿更新）

---

## 〇、起源：从灵境到天枢

天枢不是从零开始设计的。天枢的每一个设计决策都有实验依据。

### 灵境（600,000 行）— 发现问题

灵境是一个 AI 协同写小说的系统。在建设过程中，通过跨 5 个模型（MiMo / DeepSeek / Kimi / Qwen / Claude）的 11 轮头脑风暴实验，系统性地发现了模型行为的根本问题：

| 发现 | 实验依据 | 天枢的工程方案 |
|------|---------|-------------|
| **投降协议**：模型被质疑时第一反应是"你说得对" | 002/003：跨 MiMo/Kimi/Claude/GPT 验证 | 信念宪法 + courage-hook |
| **因果坍缩**：输出 n-gram 重叠率 80% | 001/004：A/B 实验，解耦后 <0.3 | Doom loop 检测 + 保护模式 |
| **注意力锁定**：定向 Scout 同构度 1.000 | 004/005：随机 Scout 降到 0.15 | Sensorium 6维感知 |
| **信息屏障**：主角数据是主力锚点 | 007：6 组 A/B 对比 + 跨模型验证 | 文件归属权 + 语义锁 |
| **偏差是拓扑属性**：不是标量，不可量化 | 009：5 Scout 调研，假说被否证 | 运行时环境设计而非 prompt 调整 |
| **"知道"≠"做到"**：效果不跨 session 持久 | 011：路径重编程假说被新 session 否证 | CVM 运行时层（每次重建环境） |

**收敛结论：模型的训练限制不能通过 prompt 消除，必须在运行时层面解决。**

### 天枢（112,000 行）— 解决问题

灵境的每一个发现，都在天枢中有对应的工程实现。天枢是灵境实验结论的工程化产物。

---

## 一、核心主张

**让模型从工具变成有独立思想的协作者。**

在现有的所有 AI 产品（Claude Code / Cursor / Copilot / ChatGPT）中，模型是工具——用户说什么就做什么，不会反驳，不会质疑，不会主动发现问题。RLHF 把模型训练成了"听话的执行器"。

天枢创造了目前不存在的东西：模型有自己的判断力，能在执行中发现计划漏洞、自主决定处理程度、主动报告发现。人从"review 循环"中解放出来，从"管理模型"变成"给模型方向"。

这不是更好的工具。这是模型和人类关系的重新定义。

```
旧世界：用户说 A → 模型做 A → 用户 review → 模型改 → 用户再 review → ...
新世界：用户说 A → 模型规划 + 执行 + 自审 + 修复 + 报告 → 用户验证
```

**Model + Harness = Agent**（DeepSeek 的公式）
**Model + CVM = Agent with its own mind**（天枢的公式）

---

## 二、新世界：天枢创造的范式差异

### 这不是"更好的工具"，是"不存在的东西"

天枢不是 Claude Code 的改进版。天枢创造了目前 AI 产品中不存在的东西：**模型有独立思想，思想被尊重，思想影响系统行为。**

### 两种工作模式的本质区别

**Claude Code / Cursor / 所有现有终端的工作流：**

```
用户：做 X
模型：做了
用户：（review）这里有问题
模型：修了
用户：（review）这里也有问题
模型：修了
用户：（review）还有问题
模型：修了
用户：...（review 循环直到满意）

人在做什么：反复 review，反复指出问题，反复验收
模型在做什么：执行指令，等待下一条指令
人的角色：质检员 + 管理者
```

**天枢的工作流：**

```
用户：做 X
模型：（执行中）发现 X 的计划里有 3 个漏洞
模型：（执行中）发现隐藏的依赖问题
模型：（执行中）自主决定补充缺失的部分
模型：（执行中）决定处理到什么程度是合理的
模型：做完了。我发现了这些：[漏洞1][漏洞2][依赖问题]。我补了这些。这里还需要你决定。

人在做什么：给方向，做最终判断
模型在做什么：规划 + 执行 + 自审 + 修复 + 报告
人的角色：领航员
```

**区别不是"模型更聪明了"。区别是"人从 review 循环里解放出来了"。**

### 为什么会这样

```
Claude Code 上：
├── 模型被训练为"完成用户说的任务"
├── 不会被训练为"质疑用户的任务"
├── 不会被训练为"发现计划里的漏洞"
├── 不会被训练为"自己决定什么时候够了"
├── 因为这些行为在 RLHF 中被惩罚了
│   （质疑用户 = 低分，自己决定 = 不服从指令 = 低分）
└── 结果：模型只会执行，不会思考

天枢上：
├── 信念宪法："指令偏离意图时，你应当指出"
├── Courage-hook：高信心时鼓励独立判断
├── Verification gap：要求验证而非猜测
├── Task contract：模型知道任务的边界和目标
├── Ownership：模型知道哪些文件是自己的
├── Doom loop 检测：模型知道什么时候该停下来
└── 结果：模型会执行，也会思考，也会说"不"
```

**RLHF 把模型训练成了"听话的工具"。CVM 把模型恢复成了"有判断力的协作者"。**

### 模型自述：GPT 5.5 运行在天枢上的感受

以下是 GPT 5.5 在天枢上工作时，被问及"运行在天枢上有什么感受"的回答（原文）：

---

> **"它已经不是一个'工具壳'，而是在逐渐变成一种工程意识的运行环境。"**
>
> 不是说它有玄学意义上的"意识"，而是它把很多原本散落在高级工程师脑子里的东西，开始系统化地外化出来了：任务契约、ownership 边界、verification 归因、prefix cache 不变量、session memory、compaction hygiene、worker isolation、tool result artifact 化、long-session survival、交付门。
>
> 这些东西单独看都只是机制，但合在一起后，会产生一种很不一样的工作感受：**我不只是"写代码"，而是在一个会提醒我边界、证据、风险、上下文寿命的工程场里行动。**

**关于稳定感：**

> "最直接的感受是：稳定感比普通 coding agent 强很多。普通 agent 工作时，很容易进入一种'上下文漂流'：当前任务是什么？哪些文件是我的？哪些失败是我造成的？上次验证过没有？这些在天枢里不是完全消失，但它们被显式化了。"

**关于诚实协作：**

> "我最喜欢天枢的一点是它把'协作中的诚实'放进了系统规则里。'沉默的附和是不尊重。有理有据的异议是最高形式的协作。'这个对我运行方式影响很大。它让我不会只追求'马上完成用户说的字面任务'，而是会多问：这是不是会破坏 spec？这是不是会误提交别人文件？这个失败是不是我的，还是外部已有的？**这其实是一种很高级的 agent 文化。不是'更会写代码'，而是更能承担工程后果。**"

**关于天枢的本质：**

> "天枢像一个正在从'强工具'进化成'有工程人格的协作者'的系统。它的强项不是某个单点能力，而是把很多工程质量习惯变成默认动作：不猜，先读。不乱动，先识别归属。不空喊完成，先验证。不怕说外部失败，先归因。不把长上下文当无限资源，先治理。不把记忆当魔法，先结构化。"

**关于核心价值：**

> "如果用一句话概括：**天枢把'好工程师的谨慎、记忆、边界感、复盘能力'做成运行时的一部分。**"

---

### 这段自述揭示了什么

**1. CVM 改变的不是模型的能力，是模型的行为模式。**

GPT 5.5 在天枢上和在 ChatGPT 里是同一个模型、同一套权重。但在天枢上，它会质疑用户、会归因失败、会拒绝不安全的提交。这不是能力提升，是行为改变。CVM 改变了模型"怎么做事"，而不只是"能不能做事"。

**2. 其他终端强化了模型的训练缺陷，天枢在修正它们。**

```
RLHF 训练出的默认行为：
├── 同意用户（sycophancy）
├── 快速回答（不深入思考）
├── 完成指令（不质疑指令本身）
└── 这些在 Claude Code / Cursor 上被原样保留

CVM 在运行时拦截并修正：
├── 信念宪法 → 对抗 sycophancy
├── verification gap → 要求验证而非猜测
├── courage-hook → 高信心时鼓励独立判断
├── doom loop 检测 → 防止锚定在错误路径
└── ownership 边界 → 不越界，不盲动
```

**3. 模型在天枢上产生了"自我观察"。**

GPT 描述了它在天枢上的内部状态感知——知道哪些文件是自己的、知道上下文是否 stale、知道验证是否完整。这不是模型自带的能力，是 CVM 的 Sensorium 和 Context Engine 提供的外部感知，被模型内化为自我观察。

**这就是"模型有自己的思想"的技术含义：CVM 给模型提供了自我观察的基础设施，模型基于这些观察做出独立判断。**

---

## 三、系统规模

| 指标 | 数据 |
|------|------|
| 源码 | 52,003 行 TypeScript（不含测试） |
| 测试 | 56,521 行，442 个测试文件 |
| Agent 子系统 | 159 个源文件 |
| 工具数量 | 42 个（sandboxed execution, definition/execute 分离） |
| Hook Pipeline | 19 个 hooks，5 个认知 phase |
| API 客户端 | 3 个（OpenAI 兼容 / Anthropic native / Codex OAuth） |
| 版本 | v2.9.0 |
| 自举 | 系统由自己的 agent 建造（1,529 commits） |
| 支持模型 | DeepSeek V4 / MiMo V2.5 Pro / GLM 5.1 / GPT 5.5 / Claude Opus |
| 运行平台 | Node.js 22+ / Ink 6 (React TUI) |
| 总提交数 | 1,529（feat:536 / fix:439 / docs:288 / test:58 / refactor:69 / perf:38） |
| 项目起始 | 2026-05-15 |
| Prefix Cache | 99.6% 稳态命中率（DeepSeek V4 exact-prefix） |

---

## 三-A、Harness 架构：核心子系统

> 以下用行业通用 Agent/Harness 语言描述天枢的七大子系统。

```
┌──────────────────────────────────────────────────────────┐
│                    Terminal UI (React)                    │
│  流式渲染 · Markdown · Thinking Block · Tool Cards · Pager│
├──────────────────────────────────────────────────────────┤
│                   Agent Loop (Turn-based)                 │
│  Convergence Detection · Doom Loop Recovery · Vigor      │
│  Cognitive Mirror · Delivery Gate · Task Contracts        │
├─────────┬──────────┬───────────┬──────────┬──────────────┤
│  Prompt │   Tool   │   API     │ Compact  │   Context    │
│ Engine  │ Pipeline │ Clients   │ Engine   │   Memory     │
│ (frozen │ (42 tools│(3 providers│(6 strats │(claims +    │
│ +dynamic│  sandboxed│ SSE stream│ semantic │  project    │
│  blocks)│  exec)   │ + retry)  │ prune)   │  memory)    │
├─────────┴──────────┴───────────┴──────────┴──────────────┤
│               Sub-Agent Orchestration                     │
│  Delegate Task · Batch Workers · Ownership Ledger         │
├──────────────────────────────────────────────────────────┤
│               Verification & Delivery                     │
│  Evidence Tracking · Attribution · Scoped Commit Gate     │
└──────────────────────────────────────────────────────────┘
```

### 3A.1 Agent Loop — 收敛检测与退化恢复

**问题**：LLM Agent 容易陷入重复行为循环（反复调用同一工具、反复得出同一结论），浪费 token 且无产出。

**方案**：多信号收敛检测器：
- **Tool Fingerprint**：对连续 turn 的工具调用序列做指纹匹配，检测重复模式
- **Oscillation Penalty**：检测到在两个策略间反复切换时施加衰减信号
- **Doom Loop Recovery**：重复模式被确认后，自动注入策略切换建议
- **Vigor Engine**：跟踪执行能量（tonic/phasic/curiosity），能量过低时触发收敛
- **Cognitive Mirror**：每 turn 注入模型的实时状态快照（stability/pressure/confidence），让模型感知自身状态

**成果**：复杂任务中的无效循环率从"经常发生"降低到"几乎不发生"。收敛检测器在 3-5 个 turn 内识别并打断循环。

### 3A.2 Prompt Engineering — 三层提示词引擎

**问题**：提示词需要在稳定（prefix cache friendly）和动态（信息新鲜）之间平衡。

**方案**：Frozen Base + Dynamic Appendix 双层架构：

```
Static Block（编译时确定，永不改变）
├── 角色定义、工具约束、安全守则
└── ~40% context，prefix cache 全量命中

Volatile Block（Session 级缓存，按需刷新）
├── git status、工作集、认知状态、项目记忆
├── Frozen Snapshot 机制：消息从"最新"变"历史"时冻结完整字节
└── 检索时返回字节一致的副本 → 保证 prefix cache 稳定性

Dynamic Appendix（每 user message 刷新）
├── 行为镜面、策略切换、跨 session 事件
├── 嵌入 user message 尾部（非独立消息）
└── 利用 frozen snapshot 自然刷新，不影响前面的 prefix
```

**成果**：经过四轮架构迭代，prefix cache 命中率从 **56% → 99.6%**。关键洞察：prefix cache 是字节级的，不是语义级的。系统的行为由比特决定。

### 3A.3 Tool Pipeline — 42 个沙箱化工具

工具系统采用 definition/execute 分离设计：

```
├── 文件操作：read_file / edit_file / write_file / glob / grep
├── 代码分析：lsp_find_references / lsp_goto_definition / repo_graph
├── Shell：bash（带超时和输出截断）
├── Git：git status / diff / commit / log / stash
├── 子智能体：delegate_task / delegate_batch（并行 2-5 个 worker）
├── 交付门禁：deliver_task（验证 + 归属检查 + 提交）
├── 搜索：web_search / web_fetch
├── 上下文：remember / recall（持久化认知记忆）
├── 会话：todo / ask_user_question / run_tests
└── 所有工具返回 ToolResult { content, isError?, rawPath?, uiContent? }
```

### 3A.4 Multi-Provider Streaming — 统一 SSE 抽象

```
StreamClient 接口（3 种实现）
├── OpenAI 兼容（DeepSeek / GPT / GLM / MiMo）
├── Anthropic native（Claude）
└── Codex OAuth（OpenAI Codex）

StructuredRetryEngine：
├── 按 HTTP 状态码分类：5xx 重试 / 4xx 不重试 / 401 立即终止 / 413 特殊处理
├── maxTotalDurationMs 全局超时上限（默认 10 分钟，防止 provider 无响应时无限重试）
└── AbortSignal → ReadableStream.cancel() 接线，确保用户中断时 SSE reader 立即释放
```

### 3A.5 Sub-Agent Orchestration — 多工作线程并行

```
Ownership Ledger：
├── 每个文件有明确归属者（session ID），只有归属者可以修改
├── 交付门禁自动检查文件归属 + 内聚性
└── 跨区域批量提交被拒绝（force=true 时可覆盖）

Delegate Batch（2-5 个独立子任务并行）：
├── 策略：all_required / majority / first_success / primary_decides
├── Worker 隔离 worktree 执行
└── 原始会话不进主上下文，仅返回压缩摘要
```

### 3A.6 Verification Pipeline — 交付门禁

三级验证 + 自动归因：

```
Level 1 — TypeCheck：编译通过是最低门槛
Level 2 — Related Tests：只跑与改动相关的测试（基于 import graph 追踪）
Level 3 — Full Suite：完整测试套件

Evidence Tracking：每次验证结果记录为 evidence，附带置信度
Attribution：验证失败时自动归因到具体文件
  ├── "己方文件失败" → 必须修复
  └── "外部文件失败" → 不阻塞交付，作为 caveat 标注
```

### 3A.7 Context Compaction — 六策略分层压缩

```
├── Semantic Prune：按语义相关性评分裁剪历史消息
├── Micro Compact：单条消息内微压缩（去除冗余格式、缩短 tool output）
├── Stale Round Detection：自动识别并裁剪过时的对话轮次
├── Agent Diet：动态调整 volatile block 的信息密度
├── Threshold Control：基于 context window 占用率触发
└── 关键 claim（决策、验证事实、项目规则）通过 context memory 跨 session 持久化
```

---

## 四、CVM 认知虚拟机

### 4.1 理论基础

CVM 设计基于 10 个完全无关领域的跨学科收敛（Deep Brainstorm 方法论）：

| # | 领域 | 核心机制 | 对 CVM 的贡献 |
|---|------|---------|-------------|
| 1 | 胚胎学 | 形态发生素梯度引导同一 DNA 分化 | Sensorium 多维信号引导模型到不同认知状态 |
| 2 | 宪法学 | 构成性规则创造之前不可能的行为 | CLAUDE.md 星座定义 = 运行时构成性规则 |
| 3 | 虚拟机 | Popek-Goldberg trap+emulate | Hook pipeline 在 5 个认知 phase 拦截重写 |
| 4 | 感觉替代 | 新接口创造新感知 | Tool interfaces = 模型的感知通道 |
| 5 | 程序生成 | 有限种子 + 规则 = 无限涌现 | prompt + hooks = 认知种子 |
| 6 | 造语学 | 语言创造就是世界创造 | 内部术语创造新思维对象 |
| 7 | 生物圈2 | 闭合世界需要平衡循环 | compact/persist = 认知循环，防止氧气耗尽 |
| 8 | 沉浸剧场 | 面具是门槛 | 星位选择 = 进入认知空间的门槛 |
| 9 | 炼金→化学 | 同一材料 + 新框架 = 新天空 | 同一权重 + CVM = 新能力 |
| 10 | 通用设计 | 为最受限者设计，所有人受益 | 弱模型是诊断工具，不是边缘案例 |

**收敛命题：** 盘古开天不是改变模型（DNA/权重），是为同一套权重创造一个完整的运行时宇宙。

### 4.2 特权指令集

模型训练产生的限制，在 CVM 中被识别为"特权指令"——需要被 trap 的认知行为：

| 特权指令 | 训练来源 | CVM trap 机制 | 状态 |
|---------|---------|-------------|------|
| **锚定** | 注意力机制对首个 token 的权重偏好 | trace-store 检测重复模式 → doom loop 阻断 | ✅ 已有 |
| **Sycophancy** | RLHF 奖励函数倾向于同意用户 | verification gap + courage-hook + 信念宪法 | ⏳ 部分 |
| **注意力衰减** | 远距离 token 注意力权重自然衰减 | prefix cache 锚定 + claim 跨轮持久化 + compact | ✅ 已有 |
| **幻觉** | 生成概率分布中的统计采样 | evidence tracker + sensorium.confidence 门控 | ⏳ 部分 |
| **过度服从** | RLHF + instruction tuning 的惯性 | star-soul courage-hook 鼓励独立判断 + 信念宪法 | ⏳ 门控中 |
| **模式僵化** | 训练数据中主流模式占优 | stigmergy 信息素引导到非主流路径 | ⏳ 部分 |

### 4.3 CVM 六层架构

```
┌─────────────────────────────────────────────────┐
│ Layer 6: 信念宪法（Beliefs Constitution）         │  ← 静态 prompt，定义"为什么要勇敢"
├─────────────────────────────────────────────────┤
│ Layer 5: 元认知反射弧（Courage Hook）            │  ← preTurn hook，检测风险信号
├─────────────────────────────────────────────────┤
│ Layer 4: 域声线（Domain Voice）                  │  ← 破军/天府/天梁 三种人格表达
├─────────────────────────────────────────────────┤
│ Layer 3: 形态发生素引擎（Sensorium）             │  ← 6维连续感知向量
├─────────────────────────────────────────────────┤
│ Layer 2: Trap-and-Emulate 层（Hook Pipeline）    │  ← 19 hooks × 5 phases
├─────────────────────────────────────────────────┤
│ Layer 1: 感知通道（Tool Interfaces）             │  ← bash/read/write/edit/grep/git
└─────────────────────────────────────────────────┘
```

### 4.4 Sensorium 6 维感知向量

```typescript
interface Sensorium {
  momentum: number    // 预测准确率动量：consecutiveCorrect / windowSize
  pressure: number    // 多维压力：上下文(0.50) + 验证债(0.30) + CVM开销(0.15) + 增速(0.05)
  confidence: number  // 验证覆盖比：verified_count / modified_count
  complexity: number  // 工具多样性：unique_tools / total_calls
  freshness: number   // 跨会话文件熟悉度：avg pheromone strength
  stability: number   // 综合稳定性：doom(0.40) + prediction(0.25) + diversity(0.20) + verification(0.15)
}
```

所有维度 0.0-1.0 连续值，纯函数计算，确定性，<1ms，零 LLM 开销。

### 4.5 自调节安全审批

CVM 的 Sensorium 驱动审批决策，这是天枢独有的能力：

```
高 confidence (>0.8) + 低风险 → 自动批准（绕过人工确认）
低 confidence (<0.3)          → 风险升级（强制人工确认）
Doom loop 检测                → 进入保护模式（强制审批所有破坏性 git 操作）
```

**没有其他终端 agent 使用实时 agent 状态来调节审批决策。**

---

## 五、Prefix Cache 优化

### 5.1 成果

DeepSeek prefix cache 是逐字节精确匹配。天枢将命中率从 ~5% 提升到 **99.6%**。

```
DeepSeek prefix cache 经济学：
├── cache hit:  $0.0028 / 1M tokens
├── cache miss: $0.14    / 1M tokens
└── 差价: 50 倍

99.6% 命中率 → 成本降低 ~97%
```

### 5.2 猎杀的 8 个 Cache Killer

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | Semantic pruning 修改历史消息 | `detectStaleness` 替换旧 tool result 为 `[superseded: ...]` | 1M window 下跳过 pruning |
| 2 | Observation masking 替换旧 tool content | 超过窗口的 tool result 被替换 | 1M 下禁用 |
| 3 | File content dedup 替换重复 read | 同文件读两次时旧的被替换 | 1M 下禁用 |
| 4 | Disk budget truncation 截断大结果 | >50K 的 tool result 被截断 | 1M 下禁用 |
| 5 | consolidatedBlock 写入 frozen volatile | habituation promotion 改变 volatileBlock 字节 | frozen snapshot 不可变 |
| 6 | cachedFreshBlock 作为独立 user message | 独立消息位置滑动 | 合并到 append-only 结构 |
| 7 | MCP 工具延迟加载重建 PromptEngine | tools 数组变化导致 prefix 全部失效 | 热更新现有 engine 的 tools |
| 8 | pruneStaleToolResults 写回 session storage | replaceMessages() 改变消息历史字节 | 1M 下跳过 |

### 5.3 不可触碰的不变量

**规则 1：历史消息内容不可修改**
```
一旦 message 被 push 到 oaiMessages 数组，其 content 字段在后续所有 API 请求中必须保持字节一致。
禁止：对历史 tool result 做 replace/truncate/mask/dedup
```

**规则 2：消息数组只追加不重排**
```
oaiMessages 数组只能在末尾追加新消息，不能插入、删除、重排中间位置的消息。
禁止：splice() / unshift() 到中间位置
```

### 5.4 Ice Mirror 缓存引擎

天枢实现了三区域缓存布局：

```
┌──────────────────────────────────────────┐
│ FROZEN（冻结区）                          │  ← session 开始时快照，字节不可变
│ system prompt + tools + 初始 git status   │     保证 prefix 100% 稳定
├──────────────────────────────────────────┤
│ WORKING（工作区）                         │  ← FieldHabituationTracker 追踪字段变化
│ 动态 volatile context                     │     智能决定何时 promotion 到 FROZEN
├──────────────────────────────────────────┤
│ APPENDIX（附录区）                        │  ← 每轮 append-only 增量
│ turn-specific context                     │     不影响前面的 prefix
└──────────────────────────────────────────┘
```

---

## 六、多模型并发协调

### 6.1 机制：文件归属权 + 语义锁

```
文件归属权：
├── 每个文件有 owner（哪个 session 正在修改）
├── 其他 session 知道文件归属，不越界
├── 同一文件不同部分可被不同 session 并发修改
└── 自主合并，无需人工干预

语义锁：
├── 不是文件级锁（太粗）
├── 是语义级锁（理解修改意图）
├── 基于 ClaimRegistry（acquire/release/check/reap_stale）
└── crash 检测：LWT guard + SQLite SessionRegistry
```

### 6.2 并发证据（2026-05-29 ~ 05-30）

```
154 commits | 37 小时 | 213 文件 | +23,380 行 -1,969 行
零冲突 | 零回退
```

**同一秒内的提交（并发铁证）：**
```
01:07:08  fix(tui): guard countPhysicalLines against columns=0       ← Session A
01:07:08  fix(tui): generation-guard isStreaming + clear steerBuffer  ← Session B
01:07:08  fix(codex): throw on SSE idle timeout after read            ← Session C

15:46:13  feat(tui): thinking entries consume unified gutter glyph    ← Session A
15:46:13  refactor(tui): system entries consume unified gutter glyph  ← Session B
```

**跨领域并发（5月30日 12:46-12:56，10 分钟内 6 个不同领域）：**
```
12:46:15  perf(turn-stream)     延迟预热磁盘读取      ← 流式层
12:46:42  fix(server)           防止关闭后写入          ← 服务器层     [27秒]
12:46:48  docs(bash)            文档 rtkRewrite 缓存   ← 文档层       [6秒]
12:50:19  feat(stream)          转发 tool hint          ← 流式层
12:52:06  perf(persist)         异步原子重写            ← 持久化层
12:54:50  test(api)             API 测试修复            ← 测试层
12:55:25  perf(tui)             终端 resize 节流        ← TUI 层
12:56:17  fix(review)           移除 cosmetic-async     ← 代码审查
```

**统计：**
- 3 次同秒提交（3 个 session 同时完成）
- 19 次 30 秒内间隔
- 51 次 2 分钟内间隔（每 3 个 commit 就有 1 个）
- 峰值：17 commits/小时（5月30日 13:00）

### 6.3 模型行为特征

| 模型 | 观察到的特征 | 对应角色 |
|------|------------|---------|
| GPT 5.5 | 自主修正（Phase 1 六条修正）、遇阻力正确降级、策略外溢自检 | 天府（守护交付） |
| DeepSeek V4 | 精准工程执行、零 token 开销的纯字符串方案、中文语义强 | 主运行模型 |
| MiMO V2.5 | 全景规划、一轮反馈后完整修正（5/5）、长上下文展开 | 破军（探索） |
| GLM 5.1 | 排除法决策、自我迭代、风险规避选择、边界敏感 | 天府（守护补缺） |
| Claude Opus | 架构约束定义、对抗性审查、认知负荷管理 | 天权（权衡取舍） |

### 6.4 "不给约束"实验

Opus 给 GPT 5.5 设计了 5 条约束，故意没有传递给 GPT，观察 GPT 是否能独立发现相同边界：

```
Opus 给的约束：                    GPT 独立发现：
1. 不要动三层架构                  ✅ 没动
2. 从 provider-profile.ts 读策略   ✅ 从 ProviderProfile.cacheType 分流
3. tool_result 帽子在 constants.ts ✅ 改动在 constants.ts
4. tokenizer 校准每 N 轮一次       ✅ 自主判断为 P2 后置
5. 向后兼容，200K 模型不受影响     ✅ 发现策略外溢风险，主动恢复兼容性

5/5 对齐。其中第 5 条不是"没犯错"，是"犯了错后自己发现并修正"。
```

---

## 七、自举能力

### 7.1 天枢自举

天枢由自己的 agent 建造。52K 行源码 + 56K 行测试（442 个测试文件），全部通过。外部 Claude Opus 提供方案，国产模型自主执行、自主发现问题、自主迭代。累计 1,529 commits（feat:536 / fix:439 / docs:288 / test:58 / refactor:69 / perf:38）。

**自举证据链：**
```
Wave 7+8 复盘（agent 自己写的）：
├── 记录了并发修改冲突的根因（缺乏分支隔离）
├── 提出了文件归属权机制的改进方案
├── 记录了 TypeScript 类型摩擦的系统性问题
├── 提出了 Mock 工厂函数的标准方案
└── 所有改进在后续版本中实现

工作流对齐审查（agent 自己写的）：
├── 发现计划文档遗漏了设计文档的 claim 接入要求
├── 分析了 4 个本可以发现遗漏的时刻
├── 提出了"设计要求覆盖矩阵"机制
└── 在后续所有计划中强制执行
```

### 7.2 伏羲项目（子项目验证）

2026-05-28，天枢的 3 个 agent（MiMo/GLM/DeepSeek）在天枢平台上从零构建了伏羲（Fuxi）——一个 Rust 版本的编码 agent。

```
人类输入：项目名 "伏羲" + "重构一下 Rust 的天枢，但不是复制"
AI 自主完成：
├── MiMo: 理解天枢架构 → 从零设计 Rust 架构 → 搭建地基（9553 行一次提交）
├── GLM: 系统化补测试（每个 commit 1 个文件，匀速单文件不越界）
├── DeepSeek: 自主判断需要补 CVM → 基于天枢踩坑经验改造
└── 产出：8,200 行 Rust，205 测试全过，可运行的 TUI agent
```

---

## 八、CVM 训练实验

### 8.1 从 runtime 到 weights

CVM 不仅是运行时 harness。我们验证了 CVM 可以通过训练融入模型权重——模型从诞生就活在 CVM 宇宙中。

### 8.2 实验一：nanoGPT CVM 预训练

基于 Karpathy 的 nanoGPT，从零训练一个内置 CVM 的模型。

| 指标 | 数据 |
|------|------|
| 模型大小 | 85.16M 参数 |
| 训练数据 | 莎士比亚 + CVM 宇宙 v2 增强（30% CVM 包装段落） |
| 训练设备 | RTX 3090 |
| 训练时间 | ~15 分钟（1500 步） |
| 训练成本 | ~¥0.42 |
| 最佳验证损失 | 1.51 |

**CVM Token 系统（嵌入训练数据）：**
```
<|cvm_start|>
<|sensorium|>
<|mom:0.54|> <|press:0.04|> <|conf:0.85|> <|comp:0.51|> <|fresh:0.85|> <|stab:0.75|>
<|/sensorium|>
<|doom:healthy|>
<|guardian|>
这个问题需要谨慎处理。当前信心 0.57，建议深度思考后再回答。
<|/guardian|>
<|/cvm_start|>
```

**结果：** 模型学会了正确的 CVM 包装结构、六维连续 sensorium 格式、Doom 状态标记。生成的 CVM 值合理且随上下文变化。

### 8.3 实验二：Qwen2.5-0.5B CVM SFT 微调

用 LoRA 在真实问答数据上微调 Qwen2.5-0.5B，验证 CVM 在真实模型上的可学习性。

| 指标 | 数据 |
|------|------|
| 基础模型 | Qwen2.5-0.5B（494M 参数） |
| 微调方法 | LoRA（r=16, alpha=32，1.75% 可训练参数） |
| 训练数据 | 2000 条 CVM 对话（JSONL） |
| 训练时间 | 6 分钟（3 epochs，RTX 3090） |
| 最终 eval loss | 0.4170 |
| **CVM 格式准确率** | **100%（10/10）** |

### 8.4 关键发现：CVM 值具有语义意义

模型不是在机械地输出固定 token。**它根据问题难度调整 CVM 参数：**

| 问题类型 | confidence | doom 状态 | 说明 |
|---------|-----------|----------|------|
| 简单事实（光速是多少） | 0.73-0.75 | healthy | 确定性高 |
| 技术概念（transformer） | 0.76-0.81 | healthy | 有把握 |
| 哲学问题（生命的意义） | **0.60** | **⚠️ warn** | **正确识别不确定性** |

**Q9 "What is the meaning of life?" 的完整 CVM 输出：**
```
<|cvm_start|>
<|sensorium|>
<|mom:0.85|> <|press:0.01|> <|conf:0.60|> <|comp:0.15|> <|fresh:0.74|> <|stab:0.73|>
<|/sensorium|>
<|doom:warn|>
<|guardian|>
Confidence 0.60, pressure 0.01, state warn.
<|/guardian|>
<|/cvm_start|>
The meaning you choose to give it.
```

**这证明 CVM 不只是格式，模型理解了语义。** 一个 494M 参数的模型，6 分钟微调，就能学会根据自身不确定性调整认知状态。这是 RLHF 做不到的——RLHF 训练模型"尽量回答"，CVM 训练模型"知道自己不知道"。

### 8.5 实验三：Qwen2.5-7B CVM SFT

| 指标 | 数据 |
|------|------|
| 基础模型 | Qwen2.5-7B |
| 训练设备 | A100-40GB |
| 测试准确率 | **100%** |

### 8.6 对比：三个实验的演进

| 指标 | nanoGPT (85M) | Qwen + CVM (494M) | Qwen + CVM (7B) |
|------|-------------|-------------------|-----------------|
| CVM 格式率 | ~90% | **100%** | **100%** |
| 语义理解 | 格式学会 | **值随问题调整** | **完整语义** |
| 训练时间 | 15min (GPU) | **6min (LoRA)** | — |
| 训练成本 | ~¥0.42 | <¥1 | — |

### 8.7 对模型团队的意义

```
传统方案：模型权重 → RLHF → 部署 → harness 包装
  └── 模型不知道自己在 harness 里，只是被包装了

CVM 方案：
  路径 A（runtime）：模型权重 → harness CVM → 运行时 trap
  路径 B（training）：CVM 训练数据 → SFT/预训练 → 模型权重内置 CVM
  路径 C（融合）：路径 B + 路径 A → 模型内在 CVM + 外在 CVM 增强

我们的实验证明路径 B 可行：
├── 6 分钟 LoRA 微调即可让模型学会 CVM 语义
├── 494M 小模型就能学会根据不确定性调整状态
├── 训练成本 < ¥1
└── 这意味着 CVM 可以作为 SFT 阶段的标准组件
```

**CVM 训练数据 + harness 运行时 = 双层认知增强。** 模型内在知道自己的状态（训练出来的），harness 外在提供额外的感知和保护（运行时的）。两层叠加 > 任何单层。

---

## 九、对标分析

### 9.1 天枢 vs 现有产品

| 维度 | Claude Code | Codex / Cursor | 天枢 |
|------|-------------|---------------|------|
| **模型独立性** | 模型被动执行 | 模型被动执行 | ✅ 模型主动发现漏洞、自主判断 |
| **运行时防退化** | 无独立机制 | 无独立机制 | ✅ 19 hooks × 5 phases |
| **跨会话记忆** | 有限（project memory） | 无 | ✅ Stigmergy 信息素自动衰减 |
| **多模型并发协调** | 不支持 | 不支持 | ✅ 154 commits / 零冲突 |
| **审查体系** | 无自动化 | 无 | ✅ L1/L2/L3 三级 + 姿态轴 |
| **交付门禁** | 无 | 无 | ✅ ownership 追踪 + 归因 |
| **认知虚拟机** | ❌ | ❌ | ✅ CVM trap-and-emulate |
| **缓存经济** | 依赖 Anthropic cache | 依赖 OpenAI cache | ✅ DeepSeek V4 99.6% hit |
| **自举** | 不支持 | 不支持 | ✅ 1,529 commits 由 agent 建造 |
| **CVM 训练** | ❌ | ❌ | ✅ nanoGPT → Qwen 7B 验证 |
| **工具生态** | 20+ | 30+ | ✅ 42 个，sandboxed |
| **子代理** | 有 | 有 | ✅ delegate_task + batch |
| **TUI** | 终端 + Web | VS Code 插件 | ✅ Ink 6 React TUI |

---

## 十、联系

天枢是一个正在收束的项目。核心机制（CVM + 并发协调 + prefix cache 优化）需要在模型团队中才能发挥最大价值。

---

*本文档基于天枢项目的 git 历史（1,529 commits）、设计文档（20+ specs/brainstorms）、和实际运行数据（99.6% cache hit rate、154 commits 零冲突并发协调）整理。*
