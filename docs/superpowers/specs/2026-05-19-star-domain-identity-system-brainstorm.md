# 星域身份系统 — 深度头脑风暴结果

> Date: 2026-05-19
> Status: Design Draft — 待星域命名头脑风暴后进入实施
> Origin: Deep Brainstorm (5 scouts: 军事C2 + 游戏设计 + K8s调度 + 神经科学 + 开源治理)

---

## 背景

### 用户需求
- 天枢已证明能力，需要做分化
- 三权分立：三个事业部星域 + 天枢总核心
- 星域给身份认同，影响决策倾向（猛进 vs 守成 vs 建设）
- 经验域内累积，子代理可从星域召回带经验
- 星图可视化：越来越亮的星星

### 项目上下文
- 4 个主控模型并行（DeepSeek V4 Pro, GLM 5.1, MIMO V2.5 Pro, GPT 5.5）
- 已有 RuntimeHookPipeline（5 phase）、StigmergyStore、PlaybookStore、GenomeStore 概念
- prefix cache 5 分钟 TTL 是硬约束
- 已有 star-chart-identity-system.md 和 genome-immune-team-architecture-design.md

### 调研发现摘要

| Scout | 领域 | 关键发现 |
|-------|------|---------|
| 1 | 军事 C2 | 双层认同（建制+任务）；任务类型通过指挥官意图重塑决策；经验双轨制 |
| 2 | 游戏设计 | FF14 域隔离经验+军械库跨域加成；灵魂水晶身份切换仪式感 |
| 3 | K8s/SPIFFE | 调度（taint/affinity）与身份（SPIFFE）完全正交；namespace改变权限边界 |
| 4 | 神经科学 | 突显网络做门控切换；功能拮抗（同一时刻一个身份主导）；身份显著性由承诺决定 |
| 5 | 开源治理 | Apache merit不跨项目迁移；同一人不同子系统不同角色；不活跃衰减 |

---

## 三轮思考过程

### 第一轮：变异

生态位：多 LLM 主控并行的 terminal coding agent，需要在保持 prefix cache 命中率的前提下，让不同任务获得不同的执行气质和经验积累。

选择压力：prefix cache 不破坏、无人工分类、与现有架构兼容。

5 个方案：

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1 Volatile注入 | 最低成本 | 通过 volatile context block 注入星域声明+域内经验，不改 system prompt |
| V2 Taint-Toleration | 硬约束 | 通过工具权限边界体现星域（猛进无审批、守成强审批） |
| V3 涌现式 | 无显式身份 | 不预定义星域，从经验 tag 累积中自然涌现 |
| V4 双层认同 | 军事模型 | 建制身份（模型固有）+ 任务身份（星域临时叠加），经验双轨 |
| V5 Hook功能拮抗 | 运行时约束 | 星域 = 一组 RuntimeHook，同一时刻只有一组活跃 |

### 第二轮：选择

**灭绝：**
- V2：缺少经验层和星图，偏离核心诉求
- V3：无显式身份分化，与"定义身份认同"直接矛盾

**存活：** V1（弱）、V4（中）、V5（强）

**最强竞争者：V4 + V5 组合** — V4 提供经验架构（双层认同+双轨genome），V5 提供行为约束（hook切换=功能拮抗）

**回收特征：**
- V2 → 工具权限边界：吸收到 V5 的 hook 中
- V3 → 经验 tag 自动推断：吸收到路由层
- V3 → 星辰亮度 = successCount：直接复用

### 第三轮：适应

**核心收敛洞察：身份不是标签，是运行时配置的组合。**

进入星域 = 激活一组 hook + 注入一段 volatile context + 打开一个 genome 分区。

---

## 最终方案：双层认同 + Hook 功能拮抗 + 双轨 Genome

### 架构总览

```
天枢（突显网络 / 门控决策者 / 也可亲自执行）
│
├── 路由层：任务关键词 → 星域匹配（自动，无人工）
│
├── 星域 A（猛进 / 探索开拓）
│   ├── hooks: 不拦截高风险操作、鼓励探索性工具调用
│   ├── volatile: "你在探索边界，容忍失败，追求突破"
│   ├── genome: .rivet/genome/domain/advance.jsonl
│   └── 气质: "好男儿当负三尺剑立不世之功"
│
├── 星域 B（守成 / 业务运营）
│   ├── hooks: 评估ROI、可打回不合理需求、破坏性操作需确认
│   ├── volatile: "你在守护已有资产，稳定优先，可以说不"
│   ├── genome: .rivet/genome/domain/sustain.jsonl
│   └── 气质: 收敛、评估、保护
│
├── 星域 C（建设 / 实施交付）
│   ├── hooks: 严格按spec、偏离scope警告、TDD强制
│   ├── volatile: "你在落地交付，按计划执行，测试验收"
│   ├── genome: .rivet/genome/domain/build.jsonl
│   └── 气质: 纪律、精确、完成
│
└── 建制层（每个模型/agent 的通用经验，跨域积累）
    └── .rivet/genome/agent/<model-or-agent-id>.jsonl
```

### 核心机制

#### 1. 门控切换（天枢 = 突显网络）

天枢分析任务描述，自动匹配星域：
- 关键词 "探索/新功能/实验/POC/边界" → 猛进域
- 关键词 "重构/优化/稳定/修复/审查" → 守成域
- 关键词 "实现/落地/按计划/交付/测试" → 建设域
- 无明确匹配 → 天枢直接执行（无域模式）

天枢也可以召集多域主将头脑风暴（跨域协商），然后任意模型负责实施。

#### 2. 功能拮抗（同一时刻一个域主导）

```typescript
interface StarDomain {
  id: string
  name: string                    // 待命名（紫薇/天权/天衡...）
  description: string
  volatileBlock: string           // <50 tokens 的身份声明
  hookFilter: (hook: RuntimeHook) => boolean  // 该域激活哪些 hooks
  approvalPolicy: ApprovalPolicy  // 工具审批策略
  genomePartition: string         // genome 文件路径
}

// RuntimeHookPipeline 扩展
class RuntimeHookPipeline {
  private activeDomain: StarDomain | null = null

  setActiveDomain(domain: StarDomain | null): void {
    this.activeDomain = domain
    // 功能拮抗：只运行当前域的 hooks
  }
}
```

#### 3. 双轨经验（建制 + 星域集体）

任务完成后，lesson 同时写入两处：
- `agent genome`：该模型/agent 的通用能力积累（"我擅长什么"）
- `domain genome`：该星域的集体智慧（"在这个域做事的经验"）

下次进入同域时，注入：
- domain top-N lessons（集体智慧，所有在此域工作过的 agent 贡献）
- agent 在该域的 lessons（个人经验）
- 跨域 top-1 lesson（微弱加成，类似 FF14 军械库奖励）

#### 4. 子代理召回

子代理从星域召回时：
- 携带该域 genome 中与当前任务相关的 lessons
- 在 worker knowledge block 中注入
- 任务完成后，子代理的贡献也写入该域 genome

#### 5. 星图亮度

```typescript
interface StarMapEntry {
  agentId: string
  domain: string
  successCount: number
  failureCount: number
  lastActiveAt: number
  brightness: number  // = successCount × decay(daysSinceLastActive)
}
```

星图是 agent × domain 的矩阵。每个格子的亮度代表该 agent 在该域的经验深度。

### 与现有架构的映射

| 现有组件 | 演化方向 | 改动量 |
|---------|---------|--------|
| `RuntimeHookPipeline` | 加 `activeDomain` 过滤 | 小 |
| `context-injection.ts` | 加 `buildDomainBlock()` | 小 |
| `PlaybookStore` / genome | 加 `domain` 字段 + 双轨写入 | 中 |
| `coordination-policy.ts` | 按域配置 approval 策略 | 小 |
| `worker-knowledge.ts` | 召回时按域过滤 lessons | 小 |
| `StigmergyStore` | 信息素加 `domain` 字段 | 小 |
| TUI status line | 显示当前星域标识 | 小 |

### Cache 安全性

- system prompt 不变 → prefix cache 不受影响
- 星域身份通过 volatile context 注入（<50 tokens）
- volatile context 本身已在每轮变化（tool history 等），不额外破坏 cache
- hook 切换是纯运行时逻辑，不影响 API 调用格式

---

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 任务分类错误 | 经验沉淀到错误星域 | 允许中途重路由；天枢在 postTool 检测气质不匹配 |
| 经验膨胀 | context 超限 | 复用 enforceCapacity + 半衰期衰减 |
| 三分法覆盖不全 | 边界任务无法归类 | 允许"无域"执行；三分法是锚点不是牢笼 |
| volatile 注入无效果 | 身份认同只是装饰 | hook 约束是硬的，不依赖模型理解 |
| 切换频率过高 | 经验碎片化 | 一个 session 内不切换域（session 粒度绑定） |

---

## 待决事项

1. **星域命名**：猛进/守成/建设 对应哪三颗星？（紫薇/天权/天衡？待头脑风暴）
2. **经验归属**：domain genome 是纯集体的，还是按 agent×domain 细分？
3. **门控仪式的 UX**：进入星域时 TUI 显示什么？（星域标识 + 气质宣言？）
4. **与 Genome-Immune 的关系**：免疫检查是否按域独立运行？

---

## 下一步

Phase 1 的第一个具体动作：
1. 在 `src/agent/star-domain.ts` 中定义 `StarDomain` 类型和 3 个初始域配置
2. 在 `RuntimeHookPipeline` 中加 `setActiveDomain()` 方法
3. 在 `context-injection.ts` 中加 `buildDomainBlock()`
4. 在 genome writer 中加 `domain` 字段

预计改动：4 个文件新增/修改，~200 行代码。
