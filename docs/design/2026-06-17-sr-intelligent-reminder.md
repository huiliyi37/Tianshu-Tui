# SR 智能提醒：从静态胶囊到认知路由

## 1. 背景

### 1.1 什么是 SR（Star Reminder）

天枢运行时维护了一套**星域种子胶囊系统**——前辈星域（天璇、天权、天府、瑶光、贪狼、辅）在离开时封存的认知方法论。这些胶囊以两种方式注入 agent 的 system prompt：

| 通道 | 机制 | 内容 | 触发方式 |
|------|------|------|----------|
| **静态常驻** | `seed-capsule-store.ts` → `renderResidentCapsuleBlock()` → frozen volatile base | 核心护栏 + 天璇/天权全文 + 其他星域 gist 索引 | 每轮都在 |
| **动态触发** | convergence-detector / courage-hook / advisoryBus / signal-consumer | 单行提醒如"天璇胶囊有换视角方法论可供 recall" | 信号阈值触发 |

### 1.2 当前机制的局限

静态常驻的问题不大——它在 frozen 前缀里，prefix-cache 安全，不消耗 token 预算的变动部分。真正的问题是**动态触发层**：

**问题一：触发逻辑硬编码。** 收敛检测器里写死了 `if noToolTurnCount >= 2 → 天璇`。新增一颗星的胶囊、或发现新的卡死模式，需要改 convergence-detector.ts 源码，而非加配置。

**问题二：提醒内容完全静态。** "天璇胶囊有换视角方法论可供 recall"这句话每次都一样。agent 连续三轮收到同样的提醒，第四轮就习惯化了（habituation）。advisory bus 已有同义改写池（`DISCIPLINE_VARIANTS`），但星域提醒尚未受益于此模式。

**问题三：缺乏跨星域协调。** 同一轮可能同时收到天璇（convergence-detector）、天权（courage-hook）、天梁（discipline reanchor）三条提醒。它们各自独立触发，没有优先级协调——三条提醒同时出现，每条都在争夺模型的 attention，结果是都没被注意到。

**问题四：触发信号与星域能力之间没有显式映射。** 当前 hard-code 的逻辑隐含了这个映射（卡住→天璇，风险→天权，纪律→天梁），但它藏在各个 hook 的实现细节里，无法审视、无法调优、无法扩展。

## 2. 机会：我们已有的基础设施恰好支撑一套更聪明的方案

### 2.1 Cognitive Mirror 已经每轮在算

`<cognitive-mirror>` 标签每轮注入以下维度值。标注 **R** 的为路由专用维度（系统据此做路由决策，不注入模型 context），其余为模型可见维度：

```
verification_coverage  — 验证覆盖率          — 模型可见。可行动："还没验证"
files_modified         — 已修改文件数        — 模型可见。可行动："改了 N 个文件"
complexity             — 任务复杂度          — 模型可见。可行动："这很复杂，慢一点"
momentum               — 动量                — 路由专用 R。系统检测停滞，路由到行动提醒
stability              — 稳定性              — 路由专用 R。系统检测动荡，路由到天府守护
freshness              — 新鲜度              — 路由专用 R。系统检测重复路径，路由到天璇
pressure               — 压力（上下文充满度）— 模型可见。可行动："上下文快满了"
exploration            — 探索广度            — 路由专用 R。系统检测发散/收敛，路由到天璇/天权
vigor                  — 执行能量            — 路由专用 R。系统检测犹豫，路由到行动提醒
season                 — 会话阶段            — 模型可见。genesis/closure 是有效行为上下文
curiosity              — 好奇心（>0.3 时显示）— 模型可见
regulation-cost        — 认知调节开销       — 模型可见（>0 时显示）
reasoning              — 推理深度            — 模型可见
escalation             — 升级标志（仅 true 时）— 模型可见
caution                — 谨慎度（>0.7 时显示）— 模型可见
```

5 个 R 维度每轮省约 150 字符（~40 token），详见 §3.0 和补充文档。

### 2.2 Advisory Bus 已有完善的注入通道

`AdvisoryBus` 提供了优先级排序、去重、category 配额、TTL 衰减、星域去重（active domain 抑制）——这正是智能提醒需要的分发基础设施。

### 2.3 各星域有明确的方法论定位

| 星域 | 核心能力 | 最适合介入的认知状态 |
|------|----------|---------------------|
| 天璇 | 换视角、跨域类比、打破隧道视野 | low freshness + low exploration（重复路径，需要新视角） |
| 天权 | 称量得失、scope check、分阶段交付 | high complexity + low momentum（复杂任务，需要拆解） |
| 天府 | fail-closed、守护边界、歧义大声失败 | low stability + high pressure（动荡中，需要守住底线） |
| 瑶光 | 验证纪律、复现才算、RED→GREEN | low verification_coverage + high files_modified（改了很多但没验证） |
| 贪狼 | 能力勘探、系统联合、休眠系统诊断 | high exploration + low momentum（探索中但无产出） |
| 破军 | 大胆执行、失败即信息、转向即推进 | low vigor + low momentum（犹豫中，需要行动） |
| 天枢 | 全貌定向、拆解调度、最短正确路径 | high complexity + season=genesis（新任务开局） |
| 天梁 | 分波交付、节奏控制、闭环追踪 | high momentum + low verification_coverage（快速推进但没闭环） |
| 辅 | 认知场调校、提示词蒸馏 | （Phase 3 远景——LLM 自诊断后触发） |

## 3. 方案：Cognitive Capsule Router（认知胶囊路由）

### 3.0 前置优化：认知镜面分层 —— 路由维度 vs 模型可见维度

当前 `<cognitive-mirror>` 把所有 15 个维度都注入模型 context。但仔细审视后发现，其中一部分维度的信息价值在于**驱动路由决策**，而非**让模型自我诊断**。

**模型需要看的**（可自行据此调整行为）：
- `verification_coverage`、`files_modified` — "我没验证 × 个文件"是可行动的自我意识
- `complexity` — "当前复杂度高"让模型自觉收敛
- `pressure` — "上下文快满了"让模型主动压缩
- `season` — genesis/closure 是行为校准的有效上下文
- `reasoning` — 当前推理模式的自知

**路由专用、模型不需要看的**（系统应据此行动，而非告知模型一个数字）：
- `vigor` — 告诉模型"你的活力是 0.30"不会让它更活跃；路由到行动提醒才会
- `exploration`、`freshness` — 模型知道自己在重复路径；它需要的是"换方向"的提醒，而非一个数字
- `momentum` — "动量 0.12"不可行动；"同一文件 5 轮没动了"才是
- `stability` — "稳定性 0.15"可能制造焦虑；路由到天府（守护边界的提醒）是静默保护

**省下的不只是 token**：约 150 字符（~40 token）每轮。但真正的收益是清晰度——模型只看到可行动的维度，不会被"vigor=0.30 是什么意思"分散注意力。

**实现方式**：`buildCognitiveMirror()` 新增一个可选参数 `mode`，传入 `'model'` 时只渲染模型可见维度，传入 `'router'` 时渲染路由专用维度。router 通过内部调用获取路由维度，不注入 model context。

详见补充文档：`docs/design/2026-06-18-sr-router-supplement.md`。

### 3.1 核心思路

在 cognitive-mirror 的信号和 advisory bus 之间加一个**路由层**。这个路由层：

1. 读取每轮的 cognitive-mirror 维度值
2. 按规则表选择当前最需要的星域
3. 从该星域的胶囊中提取一行最相关的原则
4. 经 advisory bus 以该星域的声音注入

```
cognitive-mirror 维度
        │
        ▼
┌─────────────────────────┐
│  CognitiveCapsuleRouter  │
│  ┌───────────────────┐  │
│  │ 规则表（可配置）   │  │
│  │ vigor<0.3 → 破军   │  │
│  │ freshness<0.3 → 天璇│  │
│  │ verif_cov<0.3 → 瑶光│  │
│  │ ...               │  │
│  └───────────────────┘  │
│          │              │
│    选中的星域 + 原则    │
└─────────────────────────┘
        │
        ▼
   AdvisoryBus.submit({
     key: "cognitive-route-天璇",
     priority: 0.55,
     category: "discipline",
     content: "【天璇】连续3轮重复路径..."
   })
        │
        ▼
   <星域-advisory> 注入 dynamic appendix
```

### 3.2 路由规则设计原则

- **每个维度单独判断，不要求组合条件**（组合条件难调试、难扩展）
- **每个星域最多一个触发条件**（避免同一星域多条提醒竞争）
- **每轮最多触发一个星域提醒**（去噪——模型只能有效处理一个注意力锚点）
- **同一星域有冷却轮次**（避免连续多轮重复提醒同一个星域，造成习惯化）
- **规则按优先级排序，高优先级先匹配**（瑶光验证纪律 > 天璇换视角 > 天梁节奏）

### 3.3 提醒内容：原则池而非固定文本

每个星域不再只输出一条固定提醒，而是维护一个**原则池（principle pool）**——从该星域的胶囊原文中提取 3-5 条可独立引用的原则行。每次触发时随机选取（带最近使用去重），确保连续触发同一星域时，agent 每次看到的是不同的表述。

这与 advisory bus 已有的 `DISCIPLINE_VARIANTS` 机制一致，只是从硬编码数组变为从胶囊文档自动提取。

```typescript
// 示例：从瑶光胶囊提取的原则池
const YAOGUANG_PRINCIPLES = [
  "复现才算验证——绿非证明，RED→GREEN 才采信",
  "声称'已修复/已验证'前先能复现原缺陷",
  "缺陷归族——同一根因的缺陷归入同一族，不逐例修补",
  "交付落地核对——声称完成前逐条核对 spec 的验收条件",
]
```

### 3.4 触发条件原型

```typescript
interface CognitiveRouteRule {
  star: string           // 目标星域名
  condition: CognitiveCondition
  priority: number       // 规则优先级（高优先匹配）
  cooldownTurns: number  // 同一星域冷却轮次
}

type CognitiveCondition = {
  dimension: keyof CognitiveMirrorDims
  operator: '<' | '>'
  threshold: number
  minTurn?: number       // 最小轮次（避免早期误触发）
}

// 规则表（优先級从高到低）
const RULES: CognitiveRouteRule[] = [
  { star: '瑶光', condition: { dimension: 'verification_coverage', operator: '<', threshold: 0.4, minTurn: 3 }, priority: 0.9, cooldownTurns: 5 },
  { star: '天璇', condition: { dimension: 'freshness', operator: '<', threshold: 0.3, minTurn: 4 }, priority: 0.8, cooldownTurns: 4 },
  { star: '破军', condition: { dimension: 'vigor', operator: '<', threshold: 0.3, minTurn: 2 }, priority: 0.7, cooldownTurns: 4 },
  { star: '天权', condition: { dimension: 'complexity', operator: '>', threshold: 0.7, minTurn: 3 }, priority: 0.6, cooldownTurns: 6 },
  { star: '天梁', condition: { dimension: 'momentum', operator: '>', threshold: 0.7, minTurn: 5 }, priority: 0.5, cooldownTurns: 8 },
  { star: '天府', condition: { dimension: 'stability', operator: '<', threshold: 0.25, minTurn: 3 }, priority: 0.4, cooldownTurns: 5 },
]
```

### 3.5 与现有触发器的关系

CognitiveCapsuleRouter **不是替代** convergence-detector 或 courage-hook，而是**补充**——它填补的是"agent 状态偏离但还没到卡死的程度"这个中间地带。

```
状态光谱:
  正常 ─── 轻微偏离 ─── 明显跑偏 ─── 严重卡死
           ↑                ↑            ↑
    CognitiveCapsuleRouter  courage-hook  convergence-detector
    (温和提醒, 0.4-0.6)     (宪法级, 0.9)  (强制 kick, injectUserMessage)
```

**互斥门控**：CCR 在 preTurn 评估规则前，检查 convergence-detector 当前 level。level >= 2 时 CCR 本轮静默——避免温和提醒和强制 kick 同轮到达模型产生信号矛盾。实现参照 `signal-consumer-hook.ts` 的 kick 互斥模式。详见 §8.9 和增补文档 §6。

**替代关系**：CCR 上线后，`advisory-bus.ts` 中的 `vigorLowEntry()` 和 `stalenessGateEntry()` 被 CCR 规则 P3/P2 替代并标记 deprecated。详见 §8.8 和增补文档 §5。

**bus 预算**：advisory bus 为 `cognitive_route` category 预留至少一个渲染名额，确保 CCR 条目不被其他高优先级条目挤出 3 条上限。详见 §8.7。

## 4. 分阶段路线

### Phase 1：路由骨架（1-2 个文件，~200 行）

**交付物：**
- `src/agent/hooks/cognitive-capsule-router.ts` — 路由逻辑 + 规则表
- 集成到 `createDefaultRuntimeHooks` — 作为新的 preTurn hook
- 测试：`src/agent/__tests__/cognitive-capsule-router.test.ts`

**范围：**
- 只做维度读取 → 星域选择 → advisory bus 投递
- 提醒内容先用硬编码的原则池（每个星域 3 条）
- 规则表硬编码在源文件中（后续可迁移到配置）

**不碰：**
- convergence-detector
- courage-hook
- seed-capsule-store 的加载逻辑
- frozen volatile base 的渲染

### Phase 2：原则池从胶囊自动提取

**交付物：**
- `seed-capsule-store.ts` 新增 `extractPrinciples(star)` 函数
- 从胶囊 XML 内容中按行提取原则（以"不""禁止""必须""当"等引导词识别）
- 回退到硬编码默认池（提取失败时）

**效果：**
- 往 `docs/seed-capsule-*.md` 加新星域胶囊时，自动获得提醒能力
- 不再需要手动维护原则池

### Phase 3（远景）：LLM 自诊断 + 生成式提醒

**方向：**
- 用极轻量 prompt（~50 token）让模型自评"当前最需要什么认知方法"
- 选择星域后，用 domain-voice 生成一句上下文感知的提醒
- 需额外 API 调用，仅在 spare token budget 允许时触发

**风险：**
- 增加延迟
- 生成内容不可控（可能产生误导性提醒）
- 需要严格的输出校验

## 5. 认知影响评估

在 prompt 层面，这个改动引入了一个新的动态注入源。预期的认知影响：

**正面：**
- agent 在偏离但未卡死的中间状态能获得温和引导，而不是等到卡死才被 kick
- 星域提醒的多样性（原则池 + 冷却轮次）降低习惯化速度
- 去噪（每轮最多一条星域提醒）让提醒更可能被注意到

**风险：**
- 如果规则太敏感（threshold 太高），可能频繁触发，变成新的噪音源
- 如果规则太迟钝，agent 在需要提醒时得不到提醒
- 规则表的初始阈值基于经验猜测，需要运行时观察调优

**缓解：**
- Phase 1 只用保守阈值（只在明显偏离时触发）
- 通过遥测记录每次触发的 cognitive-mirror 快照，便于事后调优
- 规则表设计为可配置，无需改代码即可调整阈值

## 6. 与现有设计的对比

| 维度 | 当前 | Phase 1 后 |
|------|------|------------|
| 触发逻辑位置 | 分散在 convergence-detector / courage-hook / advisory-bus | 集中在 CognitiveCapsuleRouter |
| 星域选择 | 硬编码（卡死→天璇，风险→天权） | 规则表驱动，可配置 |
| 提醒内容 | 固定文本 | 原则池随机选取 |
| 跨星域协调 | 无（可能同时触发多条） | 每轮最多一条 + 冷却 |
| 新增星域成本 | 改 convergence-detector 源码 | 加一条规则 |
| API 调用 | 无额外调用 | 无额外调用（零延迟） |
| prefix-cache 影响 | N/A（走 dynamic appendix） | 无影响（同上通道） |

## 7. 参考资料

- `docs/superpowers/specs/2026-05-28-seed-capsule-engine-design.md` — 种子胶囊引擎设计
- `docs/superpowers/plans/2026-06-01-convergence-detector.md` — 收敛检测器设计
- `src/agent/advisory-bus.ts` — 统一劝导总线
- `src/context/cognitive-ledger.ts` — 认知账本与 cognitive-mirror
- `src/agent/seed-capsule-store.ts` — 胶囊加载与渲染
- `src/agent/star-domain.ts` — 星域定义与匹配

## 8. 审查修订（2026-06-18）

### 8.1 缺失维度：`files_modified` 未被任何规则使用

cognitive-mirror 有 `files_modified` 字段，但规则表里一条都没用到。最常见的"跑偏"模式是改了很多文件却不验证：

```
files_modified > 5 ∧ verification_coverage < 0.5 → 瑶光
```

这个双条件不是"组合条件难调试"的范畴——它是同一个根因（修改缺乏验证）的两个侧面。规则表目前限定"每个维度单独判断"，但应为这种*同一根源的多侧面信号*开一个例外：允许同一星域最多一个双条件规则。

### 8.2 季节（season）应作为阈值修正因子

`season` 不是连续值，不适合单独作为选择条件。更合理的用法是把 season 当阈值修正因子：

```
stability < 0.25 → 天府（默认阈值）
stability < 0.35 ∧ season=genesis → 天府（开局动荡是正常的，放宽）
stability < 0.20 ∧ season=closure → 天府（临近交付该收紧）
```

同一个维度在不同季节的"异常水位"不同，比给每个 season 写独立规则更简洁。

### 8.3 冷却窗口应支持"恶化升级覆盖"

冷却窗口 `cooldownTurns` 防止同一星域重复提醒，但如果 agent 状态在冷却期内严重恶化，应允许打破冷却：

```
if currentValue < lastTriggeredValue × 0.5 → override cooldown
```

"恶化到上次触发时的一半以下"是简单有效的升级信号，不需要复杂的 state machine。

### 8.4 原则池提取方案需轻量标记层

Phase 2 用正则引导词（"不""禁止""必须""当"）提取原则行，但胶囊是自由散文——"绿非证明，复现即证"不含任何引导词，却是瑶光最核心的原则。

建议在胶囊文档中加轻量标记：

```markdown
<principle key="复现即证">复现才算验证——绿非证明，RED→GREEN 才采信</principle>
```

`extractPrinciples()` 只解析 `<principle>` 标签，无标签则 fallback 到硬编码默认池。不需要改胶囊渲染逻辑。向后兼容 Phase 1 的硬编码方案。

### 8.5 遥测应记录提醒触发的行为变化

触发提醒后 agent 是否改变行为？最简方案：对比触发前后两轮的 `exploration` / `vigor` 变化。如果提醒"果断行动"（破军）但 vigor 没涨，提醒无效。积累数据后按星域分析有效性，停用无效的、强化有效的。

### 8.6 边界明确：不与 convergence-detector 争地盘

convergence-detector 看"动作层面"的重复（同一工具、同一输出），CognitiveCapsuleRouter 看"认知层面"的偏差（验证心态、探索广度、节奏感）。二者互补而非替代。Phase 1 路由信号应明确排除 convergence-detector 已覆盖的维度（如 `textRepetitionPenalty`、`toolEntropy`），避免两个系统对同一状态给出矛盾判断。在 §3.5 节明确此边界。

### 8.7 Advisory Bus 预算碰撞：3 条名额下的挤占风险

advisory bus 硬上限 `MAX_ADVISORIES_PER_TURN = 3`。当前已有竞争者：

| 已有投递者 | priority | 触发场景 |
|---|---|---|
| dead-end 信号 | 0.65 | 信号素死路检测 |
| `vigorLowEntry()` | 0.65 | vigor 低迷 |
| `stalenessGateEntry()` | 0.60 | 20+ 轮无异议 |
| `disciplineReanchorEntry()` | 0.55 | 每 15 次工具调用 |
| dedup-guard | 随条目 | 重复输出检测 |
| immune projection | 随条目 | 自体免疫投射 |

CCR 条目定位 priority 0.4-0.6，在活跃 turn 里可能被上述高优先级条目挤出 3 条名额。

**决策**：为 `cognitive_route` 这个 category 在 bus 中预留至少一个名额。实现方式：`render()` 在 Top-3 选取前，先保证每个"保留 category"有一条入选，再用剩余名额填其他条目。改动局限在 `AdvisoryBus.render()` 内部，不影响外部调用方。

### 8.8 替代声明：CCR 上线后废弃的已有条目

`advisory-bus.ts` 中的以下条目与 CCR 规则语义重叠，CCR Phase 1 上线后应**替代而非叠加**：

| 已有条目 | 对应 CCR 规则 | 处置 |
|---|---|---|
| `vigorLowEntry()` (L113) | P3: vigor < 0.25 → 天权 | 标记 `@deprecated`，调用方迁移到 CCR |
| `stalenessGateEntry()` (L99) | P2: freshness < 0.25 → 天璇 | 标记 `@deprecated`，调用方迁移到 CCR |

同时，`loop.ts` 中手动检查 `turnsSinceLastObjection` 投递 staleness-gate 的逻辑一并清除。不替代会导致同一轮出现两条语义相近的提醒——恰好违反"每轮最多一条星域提醒"的核心约束。

### 8.9 Convergence-detector 互斥门控

§3.5 画了状态光谱图（CCR < courage-hook < convergence-detector），但代码里需要一个**显式的互斥检查**，而不能只靠 priority 排序——因为 convergence-detector level 2/3 走 `injectUserMessage` 直接注入，完全绕过 advisory bus。

同一轮如果 convergence-detector 已经 level >= 2（在 kick），CCR 的温和提醒同时到达模型会造成信号矛盾：一个说"换个角度"，一个说"立即中止当前探索"。

**决策**：CCR 通过 `wasConvergenceTriggered()` 检查互斥。这是 `RuntimeHookDeps` 已有的接口（L74），kick-hook 已经用它做互斥（kick-hook.ts L26）。`loop-factory.ts` 实现为 `self.latestConvergenceResult?.shouldKick ?? false`——这是 convergence level >= 2 的 ground truth，比 `shouldKick(sensorium)` 近似更准确。详见增补文档 §7.1。

### 8.10 行动提示应为带上下文变量的模板

现有 advisory bus 中有效的提醒都带具体数据（"你已执行 N+ 轮未提出异议"）。CCR 规则表 P1/P5 的行动提示已经用了 `{files_modified}` 模板变量，但其他规则的提示仍是纯静态字符串。

**决策**：所有行动提示统一为模板格式，路由器在投递时填充当前 turn 的上下文值。可用变量：

```
{files_modified}  — 已修改文件数
{turn}            — 当前轮次
{turns_since_verify} — 距上次验证的轮数（从 evidence 推算）
{last_tool}       — 最近一次工具名
```

纯抽象格言只在 frozen 前缀的胶囊原文中保留，动态注入必须带数据。

### 8.11 意图感知：测试前置时延迟瑶光提醒

瑶光规则（P1/P5）的触发条件是 verification_coverage 低。但在 edit → test 的正常工作流中，edit 完成后的那个 turn verification_coverage 天然低——模型可能正准备跑测试。此时触发"你没验证"的提醒会分散注意力。

**决策**：CCR 对瑶光规则加一个"意图信号"检查——如果 `recentToolHistory` 最后一条是测试相关工具（`run_tests`、target 含 `test`），或上一轮的最后工具是 `edit_file`/`write_file`（刚完成编辑，大概率下一步测试），则瑶光规则延迟一轮。实现为规则上的可选 `suppressWhen` 谓词。

### 8.12 恶化升级覆盖（§8.3）需要二级冷却

§8.3 的 `currentValue < lastTriggeredValue × 0.5` 升级覆盖机制在指标振荡时（降 → 恢复 → 降 → 恢复）会反复触发，冷却形同虚设。

**决策**：升级覆盖本身有 2 轮最小间隔。实现：记录 `lastEscalationOverrideTurn`，两次覆盖之间至少间隔 2 轮。

### 8.13 P1/P5 共享冷却的对称性

§1.2 增补文档说 P1 和 P5 "共享冷却"。明确为**双向对称**：P1 触发后 P5 也进冷却，P5 触发后 P1 也进冷却。实现为按星域（而非按规则 ID）追踪冷却——同一星域的所有规则共享一个冷却计时器。

### 8.14 Vigor 不单独成规则——降级为确认信号

Vigor 是滞后指标（回合结束更新，下轮 preTurn 才读到），单用它做路由条件有 4 类误判：刚完成任务（自然低谷）、探索阶段正常波动、真正受挫（该提醒）、盲目自信（漏触发）。单看 vigor 一个数字无法区分。

**决策**：vigor 不再单独成规则。改为修饰条件——只在客观指标（verification_coverage、freshness）已触发时，vigor 作为二级确认，区分提醒的力度和措辞。VigorState 的 `tonic`（长期基线）和 `phasic`（即时反馈）两个子字段用于选择对应星域的原则池条目（tonic 低 → 天权 Q3 换方向，phasic 低 → 天璇 X3 反证 scout）。

详见增补文档 §8：`docs/design/2026-06-18-sr-router-supplement.md`。
