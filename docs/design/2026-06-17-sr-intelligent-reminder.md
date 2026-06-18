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

`<cognitive-mirror>` 标签每轮注入以下维度值：

```
verification_coverage  — 验证覆盖率（高=已验证，低=没验证）
files_modified         — 已修改文件数
complexity             — 任务复杂度
momentum               — 动量（高=持续推进，低=停滞）
stability              — 稳定性（高=模式固定，低=动荡）
freshness              — 新鲜度（高=新信息多，低=重复路径）
pressure               — 压力（高=任务过大）
exploration            — 探索广度（高=发散，低=收敛）
vigor                  — 执行能量（高=在干活，低=疲惫/犹豫）
season                 — 会话阶段（genesis/growth/climax/closure）
```

这些维度恰好对应不同星域的核心能力。

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
    (温和提醒)              (宪法级纠正)   (强制 kick)
```

现有的 convergence-detector 和 courage-hook 保持不变。CognitiveCapsuleRouter 以较低优先级（0.4-0.6）投递到 advisory bus，不与宪法级条目（0.9）竞争。

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
