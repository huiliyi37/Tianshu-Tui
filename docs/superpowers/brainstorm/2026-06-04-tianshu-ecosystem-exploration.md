# 天枢生态项目探索 · Deep-Brainstorm

> 日期：2026-06-04
> 方法：deep-brainstorm（变异 → 选择 → 适应 + 定向反证）
> 锚定源：天枢四原则（溶解即新生 / 有限规则无限涌现 / 参考系锚定 / 模糊是力量）
> 种子问题：天枢的理论框架可以构建哪些新的生态项目？

---

## Phase 1: 碎片收集（跨域探索）

### Scout 1: AI 领域 — 多 Agent 协作平台

**碎片 A1: 星盟协作协议**

天枢已有 coordinator.ts（多 worker 并行调度）、delegate_batch（任务分发）、ownership ledger（文件归属）。核心模式是：
- 主 agent 作为"天枢"接收任务，拆解为子任务
- worker agent 并行执行，各自有独立 session/context
- 产出通过 artifact store + claim store 汇聚

**可独立产品化的能力**：将这个模式泛化为一个 **multi-agent orchestration SDK**。

**碎片 A2: 前缀缓存哲学**

天枢的 prefix cache 策略不只是技术优化——它是一种"参考系锚定"的工程实现。让对话在固定锚点下生长，而不是每次重新定位。这在 LLM 应用中是普遍稀缺的能力。

**碎片 A3: 上下文压力管理**

天枢有三层上下文压缩：
- L0: per-call read cap（token fraction per call）
- L1: per-turn read budget（15% window）
- L2: context-pressure preflight（>70% truncation）

这在任何长对话 AI 产品中都是刚需。

### Scout 2: 终端/开发工具 — 天枢 TUI 框架

**碎片 B1: Ink 6 + React 终端应用框架**

天枢的 TUI 基于 Ink 6（React for CLI），实现了：
- `<Static>` 组件的历史消息不可变渲染
- 流式 streaming 的增量更新
- 月相呼吸指示器等微动画
- 撤回（rewind）机制
- 响应式布局

**可独立产品化**：一个 **terminal UI component library**，让开发者可以像写 React web app 一样写终端应用。

**碎片 B2: 终端聊天工具**

用户提到的 bot 聊天场景。天枢已经有了完整的消息渲染、流式输出、thinking 动画、tool 调用卡片。核心 UI 组件可以复用。

### Scout 3: 知识管理 — 项目记忆系统

**碎片 C1: Claim Store 知识图谱**

天枢的 claim-store 是 event-sourced JSONL + projection：
- 5 种 claim type（decision / file_observation / verification_fact / failure_pattern / project_rule）
- 自动提取、冲突检测、衰减、promotion 生命周期
- 关键词检索 + context-aware relevance scoring

**可独立产品化**：一个 **project knowledge base SDK**，让任何工具都能拥有"项目记忆"。

**碎片 C2: 认知镜（Cognitive Mirror）**

天枢的 cognitive-mirror 系统在每个 turn 报告 agent 的内部状态（verification_coverage、complexity、momentum 等），让人类可以"看到"AI 的思维过程。

### Scout 4: 非技术领域 — 教育与创意

**碎片 D1: 苏格拉底式教学助手**

原则四（模糊是力量）+ 德尔菲模式 = **不直接给答案，用结构化提问引导思考**。当 confidence < 0.4 时输出"有两种可能：A 因为 X，B 因为 Y"。

**碎片 D2: 协作式创意工具**

天枢的 seed-capsule 机制（前辈 AI 封存认知方法供后来者调用）可以泛化为一个 **AI 认知遗产平台**——每个 AI 实例可以留下"方法胶囊"供其他实例或人类参考。

### Scout 5: 反证 — 什么不应该做

**定向反证: 杀死高概念寄生虫**

- ❌ 通用 AI Agent 框架：市场已饱和（LangChain、CrewAI、AutoGen）。天枢的差异化在于**具体**——它是一个 terminal coding agent，不是万能框架。
- ❌ 另一个 ChatGPT 包装器：天枢的核心价值不是 LLM 调用层，而是工程方法论（四原则、三层压缩、星域路由等）。
- ❌ 纯文档/方法论项目：没有可执行代码的方法论是死的。天枢的原则之所以有用，是因为它们被验证在具体代码中。

**存活判据**：任何新项目必须（1）复用天枢的具体代码/模式，（2）解决一个具体痛点，（3）不在已有竞品的红海中。

---

## Phase 2: 方案演化（变异 → 选择 → 适应）

### 方案 V1: 星枢 — Multi-Agent Terminal Studio

**定位**：一个终端原生的多 Agent 协作 IDE，基于天枢的 coordinator + TUI + claim-store。

**核心复用**：
- coordinator.ts → 多 agent 调度引擎
- TUI 组件 → 终端渲染框架
- claim-store → 跨 session 知识持久化
- ownership ledger → 多 agent 文件归属

**差异化**：不是通用 agent framework，而是**终端原生的 coding multi-agent**。每个 worker 是一个独立的 coding agent，有独立的 context window，通过 artifact store 共享产出。

**市场空位**：当前没有终端原生的 multi-agent coding tool。Devin/GPT Engineer 是 web 端，Claude Code 是单 agent。

**风险**：multi-agent 的调试复杂度极高。天枢自己的 delegate_batch 失败率就说明了这一点。

**适应度评分**：
| 维度 | 分数 | 理由 |
|------|------|------|
| 复用率 | 9/10 | 核心 engine 已有 |
| 市场需求 | 7/10 | 多 agent 是热点但需求模糊 |
| 差异化 | 8/10 | 终端原生 + 实际工程验证 |
| 实现难度 | 4/10 | 需要稳定的 multi-agent 基础 |

### 方案 V2: 天鉴 — Project Knowledge Server

**定位**：一个独立的项目知识服务，为任何开发工具提供"项目记忆"。

**核心复用**：
- claim-store → 知识存储引擎
- claim-extractor → 自动知识提取
- pheromone/sensorium → 项目状态感知
- recall → 知识检索
- promotion → 知识生命周期管理

**架构**：
```
任何工具 → HTTP/MCP API → 天鉴 Server → .tianjian/ 项目知识库
                                      ↗ claim-store (JSONL)
                                      ↗ pheromone (状态信号)
                                      ↗ relevance scorer (上下文匹配)
```

**差异化**：不是 RAG（向量化文档），而是**结构化 claim + event-sourced + context-aware**。每个知识条目有生命周期（active → durable → stale），有冲突检测，有上下文相关性评分。

**市场空位**：Cursor、Claude Code、Windsurf 都需要项目知识，但没有统一的"项目记忆服务"。

**适应度评分**：
| 维度 | 分数 | 理由 |
|------|------|------|
| 复用率 | 8/10 | claim-store 已有但需解耦 |
| 市场需求 | 9/10 | 所有 AI coding tool 都需要 |
| 差异化 | 9/10 | 结构化 claim 不是 RAG |
| 实现难度 | 7/10 | 需要独立的 transport 层 |

### 方案 V3: 天河 — Terminal Chat Framework

**定位**：一个终端聊天 UI 框架，支持多 bot、流式输出、tool 调用可视化。用户可以用它构建自己的终端聊天应用。

**核心复用**：
- TUI Static + 动态渲染 → 消息列表
- 流式 streaming → 打字机效果
- tool-card → tool 调用可视化
- 月相指示器 → 活动状态
- rewind → 消息撤回
- 缓存诊断 → 性能面板

**架构**：
```
用户配置 → 天河 Framework → 终端 UI
                ↗ React/Ink 组件库
                ↗ Provider adapter（OpenAI/DeepSeek/GLM/Claude）
                ↗ Plugin 系统（tool 注册 + 自定义渲染）
```

**差异化**：不是又一个 tui-chat，而是一个**框架**。用户可以：
- 配置多个 bot（不同 provider、不同 system prompt）
- 注册自定义 tool（用天枢的 Tool interface）
- 自定义渲染组件
- 插入中间件（类似天枢的 hook pipeline）

**市场空位**：终端聊天工具多为单一用途（比如 chatgpt-cli）。没有可扩展的终端聊天框架。

**适应度评分**：
| 维度 | 分数 | 理由 |
|------|------|------|
| 复用率 | 9/10 | TUI 组件可直接提取 |
| 市场需求 | 6/10 | 终端用户群有限但忠诚 |
| 差异化 | 8/10 | 框架级产品少 |
| 实现难度 | 7/10 | 需要抽象 TUI 层 |

### 方案 V4: 天衡 — Context Pressure SDK

**定位**：一个 LLM 上下文管理 SDK，为任何 AI 应用提供多层压缩、预算控制、缓存优化。

**核心复用**：
- model-read-cap → 单次读取上限
- per-message-budget → 每轮总预算
- context-pressure-truncation → 高压力截断
- compact/prune → 上下文压缩
- prefix-cache → 前缀缓存策略
- cache-advisor → 自适应缓存阈值

**差异化**：不只是一个 truncate 函数，而是一套**分层上下文管理策略**，基于天枢的实际工程验证（200K 窗口下 180 turn 稳定运行，93.1% cache hit rate）。

**市场空位**：所有长对话 AI 产品都需要上下文管理。当前方案都是简单的 truncate + summarize，没有天枢的多层策略。

**适应度评分**：
| 维度 | 分数 | 理由 |
|------|------|------|
| 复用率 | 9/10 | 核心算法已有 |
| 市场需求 | 8/10 | 通用需求 |
| 差异化 | 7/10 | 需要证明优于简单方案 |
| 实现难度 | 8/10 | SDK 化相对简单 |

---

## Phase 3: 反证 + 选择

### 定向反证

**对 V1（星枢 Multi-Agent Studio）的反证**：
- 天枢自己的 delegate_batch 在 GLM 下卡死——multi-agent 稳定性未经验证
- 多 agent 协调的认知负担对用户极高——Devin 的用户体验证明了这一点
- **判定：假设级反证**。技术上可以解决，但用户体验风险高。

**对 V2（天鉴 Knowledge Server）的反证**：
- MCP 协议已经在做类似的事——MCP Memory Server
- 结构化 claim 的维护成本可能比 RAG 更高
- **判定：事实级反证**。MCP 已有 memory server，天鉴需要证明结构化 claim > 向量检索。
- **回收**：但 MCP Memory Server 没有 claim 生命周期和冲突检测——这是天鉴的差异化。

**对 V3（天河 Chat Framework）的反证**：
- Ink 6 本身就是终端 UI 框架——天河是否只是 Ink 6 的一层薄包装？
- 终端用户群确实有限
- **判定：假设级反证**。天河的价值在于预构建的 chat 组件 + provider adapter，不只是 Ink wrapper。

**对 V4（天衡 Context SDK）的反证**：
- 各家 LLM provider 已经在 API 层做了 caching——天衡是否在重复造轮子？
- **判定：假设级反证**。Provider 做的是 server-side cache，天衡做的是 client-side 的多层策略（budget + truncate + compact）。两者互补。

### 选择结果

**存活方案**：V2（天鉴）+ V4（天衡）+ V3（天河）

**灭绝方案**：V1（星枢）—— multi-agent 稳定性不足，用户体验未验证。

**特征回收**：从 V1 回收 coordinator 的任务分发模式到 V3（天河可以支持多 bot 协作对话）。

---

## Phase 4: 收敛方案

### 优先级排序

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P0** | V4 天衡 — Context Pressure SDK | 复用率最高、实现最简单、市场最通用 |
| **P1** | V2 天鉴 — Project Knowledge Server | 需求最强、差异化最明确、但实现量最大 |
| **P2** | V3 天河 — Terminal Chat Framework | 天枢 TUI 的自然延伸、但用户群有限 |

### 建议实施路径

**第一步（1-2 周）：天衡 SDK**
1. 从天枢提取 model-read-cap、per-message-budget、compact/prune 为独立 npm 包
2. 发布为 `@tianshu/context-sdk`
3. 提供简单的 API：
```typescript
import { ContextManager } from '@tianshu/context-sdk'
const cm = new ContextManager({ windowSize: 200_000 })
cm.addToolResult(toolName, content)  // 自动应用三层预算
cm.getUsage()  // { estimated: 111K, pressure: 55%, budgetRemaining: 30K }
```

**第二步（3-4 周）：天鉴 Server**
1. 解耦 claim-store 为独立服务
2. 提供 HTTP + MCP 双接口
3. 第一个集成方：天枢自身（用天鉴替代内嵌的 claim-store）

**第三步（5-8 周）：天河 Framework**
1. 提取 TUI 组件为独立 React/Ink 组件库
2. 提供 provider adapter 层
3. 发布为 `@tianshu/chat-framework`

---

## 附：碎片池统计

| Scout | 领域 | 碎片数 |
|-------|------|--------|
| Scout 1 | AI/Agent | 3 |
| Scout 2 | 终端工具 | 2 |
| Scout 3 | 知识管理 | 2 |
| Scout 4 | 教育/创意 | 2 |
| Scout 5 | 反证 | 3 条反证 |
| **总计** | | **12 碎片 + 3 反证** |

---

*本文档为天枢 deep-brainstorm 输出。方法论：天璇（跨域碎片 → 收敛 → 定向反证 → 特征回收）。*
*四原则锚定：溶解即新生（claim 生命周期）/ 有限规则无限涌现（三层 budget）/ 参考系锚定（prefix cache）/ 模糊是力量（结构化模糊输出）。*
