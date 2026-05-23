# P3 前沿技术调研 · 设计文档

> Deep-research 输出 · 2026-05-23
> 6 个 scout 并行调研：前沿总览 / AgenticCache / Online RL / Speculative Execution / Temporal Straightening / 异步后台代理
> 视角：天璇（边界行走 · 跨域共振）

---

## 背景

原始 P3 路线图包含 4 个方向：
1. AgenticCache（计划缓存）
2. Online RL（用户偏好学习）
3. Speculative Edit（推测式编辑）
4. 异步后台代理（"Sleep While Coding"）

调研后发现 **6 个额外的高影响力技术**，部分比原始 P3 更有价值。

---

## 第一部分：超出预期的发现

### Agent JIT Compilation (ICML 2026)

将任务描述编译为可执行代码（含并行化和工具验证），而非逐步 JSON action。

- **数字**：10.4x 加速，+28% 准确率（vs Browser-Use）
- **状态**：无产品实现
- **核心洞察**：为什么跑慢速 agent loop，当你可以把它编译成并行代码？
- **Rivet 适配**：将重复的 tool-call 序列编译为 TypeScript 函数，直接执行

### IdleSpec: Speculative Planning (2026.05)

利用工具执行等待期间的空闲时间，推测性生成计划候选。

- **数字**：+9.1% on MLE-Bench（长任务）
- **状态**：无产品实现
- **核心洞察**：工具等待时间是免费算力。DeepSeek Flash 12x 便宜使推测几乎免费。
- **Rivet 适配**：在 tool-pipeline 的 await 期间，用 Flash 生成下一步候选

### AgentDiet: Trajectory Reduction (FSE 2026)

实时移除 agent 轨迹中无用、冗余、过期的信息。

- **数字**：39.9-59.7% token 减少，21.1-35.9% 成本减少，零性能损失
- **状态**：无产品实现
- **核心洞察**：生产 agent 永远保留所有 tool result。这是纯浪费。
- **Rivet 适配**：post-tool hook，标记可移除的轨迹段（与现有 observation masking 互补）

### Atropos: Early Termination + Model Hotswap (ISSTA 2026)

GCN 预测器检测失败轨迹，中途切换到更强模型。

- **数字**：74.35% 闭源模型性能 @ 23.9% 成本
- **状态**：无产品实现
- **核心洞察**：每个 turn 都用 Flash 开始，仅在预测器标记失败时升级到 Pro。
- **Rivet 适配**：扩展我们刚做的 P2-14 task-complexity，加入轨迹级失败预测

### Mistake Notebook Learning (2026.01)

批量聚类失败经验，蒸馏为结构化"错误笔记"，检索时注入以避免重蹈覆辙。

- **数字**：训练免费，持续改进（无具体百分比，但多篇论文验证有效）
- **状态**：无编程 agent 实现
- **核心洞察**：一个文件说"上次遇到错误 X，修复方法是 Y"。没有 coding agent 做这个。
- **Rivet 适配**：与 Songline durable claims + stigmergy 完美对齐。1 天实现。

### Experiential Reflective Learning (ICLR 2026 Workshop)

反思任务轨迹生成可操作启发式规则，检索时注入。

- **数字**：+7.8% on Gaia2（vs ReAct）
- **状态**：训练免费，无产品实现
- **Rivet 适配**：dream hook 的自然扩展——session 结束时反思，生成规则

---

## 第二部分：原始 P3 方向深化

### 16. AgenticCache — 计划缓存

#### 核心论文

| 论文 | 来源 | 日期 | 关键数字 |
|------|------|------|---------|
| AgenticCache | MLSys 2026 (Kim, Wu, Tambe) | 2026.04 | +22% 成功率, -65% 延迟, -50% tokens |
| Agentic Plan Caching (APC) | ICML 2025 (Stanford: Zhang, Wornow, Olukotun) | 2025.06 | -46.62% 成本, 96.67% 准确率 |
| AgentReuse | 2025 | 2025 | -93% 延迟, 93% 复用率 |
| Why Agent Caching Fails | arXiv 2602.18922 | 2026.02 | W5H2 结构化意图规范化 |
| vCache | ICLR 2026 | 2026 | 自适应阈值，错误率 <1.3% |

#### 技术方案

**APC (Stanford)**：
1. 从完成的执行中提取抽象计划模板（不是完整 trace）
2. 通过**关键词提取**匹配新任务（优于语义相似度）
3. 轻量 LLM 将缓存模板适配到具体任务

**AgenticCache**：
1. 利用"计划局部性"（当前计划预示下一个计划）
2. 维护转移缓存
3. 后台 LLM 调用异步验证

#### 失效策略

无论文直接解决代码变更失效。"Why Agent Caching Fails" 识别了这个 gap。
- **建议方案**：文件变更事件触发涉及路径的缓存失效
- **vCache 方案**：per-entry 自适应阈值 + 在线学习验证

#### 最小可行版本

基于 [muscle-mem](https://pypi.org/project/muscle-mem/)：
1. 录制工具调用序列
2. 精确匹配时回放
3. Miss 时回退到 LLM
4. 文件变更 → 失效相关缓存条目

#### 与 DeepSeek prefix cache 的关系

**互补**：
- Prefix cache 省推理计算（KV 复用）
- Plan cache 省规划 token（跳过推理）
- 叠加 = 稳定前缀命中缓存 + 规划步骤完全跳过
- **风险**：缓存计划改变 prompt 结构 → 可能破坏 prefix cache 对齐
- **解决**：计划模板作为 suffix 内容，在稳定 prefix 边界之后

#### 开源

- [MLSys26_AgenticCache](https://github.com/hojoonleokim/MLSys26_AgenticCache)
- [muscle-mem](https://pypi.org/project/muscle-mem/0.0.1/) — 录制+回放工具序列
- CodeMEM (2026.01) — 将重复工具序列结晶为版本化 Python 函数

---

### 17. Online RL — 用户偏好学习

#### Cursor Tab 的真实架构

| 指标 | 数据 |
|------|------|
| 日请求量 | >4 亿次 |
| 方法 | 策略梯度（无独立奖励模型） |
| 奖励函数 | accept=+0.75, reject=-0.25, 无建议=0 |
| 阈值 | 仅在接受概率 >25% 时建议 |
| 部署频率 | 每 1.5-2 小时新 checkpoint |
| 效果 | 建议量 -21%, 接受率 +28% |
| 模型演化 | 旧 speculative edit → Fusion → Tab RL |

来源：[Cursor Tab RL Blog](https://cursor.com/zh-Hant/blog/tab-rl)

#### 关键论文

| 论文 | 日期 | 核心贡献 |
|------|------|---------|
| SafeDPO | ICLR 2026 Oral | 闭式最优策略，仅需偏好数据+安全标签 |
| G-Zero | 2026.05 | 自博弈对齐，仅用 log-prob shift |
| DVPO | 2025.02 | 冻结全局价值模型作为通用 critic |
| Pref-GUIDE | TMLR 2025 | 噪声标量反馈→结构化偏好对 |
| Active DPO | 2025.03 | D-optimal 实验设计，标注需求 -8x |
| One-Pass Reward Modeling | NeurIPS 2025 | 常数时间更新，无需存储历史 |

#### 开源复现

- [RLinf](https://github.com/RLinf/RLinf) (清华/无问芯穹) — Qwen2.5-Coder-1.5B + Continue 插件，评分 +52%
- [@oraclaw/bandit](https://www.npmjs.com/package/@oraclaw/bandit) — LinUCB npm 包，MCP 工具集成

#### 轻量替代方案（无需 GPU）

1. **Contextual Bandit (LinUCB)** — 在进程内运行，在线更新，无 GPU
2. **检索增强偏好存储** — 维护 accept/reject 历史，按代码上下文索引，推理时检索相似交互
3. **One-Pass Reward Modeling** — 常数时间更新，不存储历史数据

#### 冷启动

- Firebase 推荐：最少 14 天数据
- Cursor：几天内可见风格适应
- Active DPO：减少 8x 标注需求
- UserVille：20+ 用户 persona 模拟训练，零样本迁移

#### DeepSeek 角度

低成本推理使训练循环更频繁。但需要快速 checkpoint 部署（模型热加载）。
对于 Rivet 的现实路径：**先用 contextual bandit（无 GPU），积累数据后再考虑 RL**。

---

### 18. Speculative Execution — 推测式工具执行

#### PASTE 论文详情

**标题**：Act While Thinking: Accelerating LLM Agents via Pattern-Aware Speculative Tool Execution
**作者**：隋一帆, 赵涵, 马瑞 等（上海交大 + 微软研究院 + Stevens）
**日期**：2026.03, arXiv:2603.18897
**后续**：B-PASTE (arXiv:2604.16469, 2026.04) — 边缘部署的 beam-aware 推测

| 指标 | 数字 |
|------|------|
| 整体命中率 | 93.8%（多路推测） |
| Top-1 准确率 | 27.8% |
| Top-3 召回率 | 43.9% |
| 延迟降低 | 48.5% |
| 工具吞吐量 | 1.8x |
| 工具等待时间降低 | 67% |

#### 关键区分

| 层级 | 技术 | 单位 | 回滚成本 |
|------|------|------|---------|
| Token 级 | Speculative Decoding | tokens | 近零 |
| Tool 级 | PASTE / Shadow Queue | 整个 API 调用 | 可能高（副作用） |
| 索引级 | SpecAgent | 文件预取 | 零 |

**两者互补** — 可以同时加速 token 生成 AND 预执行工具。

#### Cursor 的演化

Speculative edit → Fusion 模型 (client 0.45.0) → Tab RL
- Fusion：+25% 准确率，10x 更长建议，延迟 475ms→260ms
- 不是"废弃"，是被吸收进了持续学习的 Tab 模型

#### 开源实现

| 项目 | 描述 |
|------|------|
| [Zeph](https://github.com/bug-ops/zeph) | PASTE 风格 pattern-learning 工具编排 |
| [KAIJU](https://github.com/compdeep/kaiju) | intent-gated 并行工具调度 + 依赖解析 |
| [DeepLossless](https://github.com/gordonlu/deeplossless) | 推理感知运行时，推测式工具 profile，-36% token |
| [LLMCompiler](https://github.com/SqueezeAILab/LLMCompiler) (ICML 2024) | 并行独立工具调用，3.7x 延迟改善 |

#### DeepSeek 的不对称优势

- 连续 agentic session 中 **99.41% cache hit rate**
- V4-Flash 输出比 GPT-5.5 Pro 便宜 **640x**
- 第二个推测请求（共享 prefix）成本几乎为零
- **结论**：可以激进地多路推测（3-5 路），废弃成本可忽略

---

### 19. 异步后台代理 + 时域拉直

#### 时域拉直 (ICML 2026)

**论文**：Temporal Straightening for Latent Planning
**作者**：Ying Wang, Oumayma Bounou, Gaoyue Zhou, Randall Balestriero, Tim G. J. Rudner, Yann LeCun, Mengye Ren
**来源**：[agenticlearning.ai/temporal-straightening](https://agenticlearning.ai/temporal-straightening/)

**核心**：曲率正则化 `L_curv = 1 - cos(v_t, v_{t+1})`
- 惩罚连续潜在过渡向量间的急转弯
- 强制轨迹局部"拉直"
- 欧氏距离更接近测地距离 → 梯度规划改善

**效果**：开环规划 +20-60%，MPC +20-30%

**对 coding agent 的启示**：
- 直接应用需要 logit 访问（API agent 不可行）
- **Prompt 层近似**："保持推理简洁。每一步都应离最终答案更近。不要来回切换视角。"
- 与 AgentDiet 互补：移除轨迹中的"急转弯"段

#### 跨 Session 学习突破

| 技术 | 来源 | 效果 |
|------|------|------|
| Claude "Dreaming" | Anthropic 2026.05 | 会话间回顾，Harvey 任务完成率 6x |
| ALTK-Evolve | IBM 2026.04 | 轨迹→可复用指南，困难任务 +14.2% |
| MetaClaw | 2026.03 | 用户不活跃时优化策略，21.4%→40.6% |
| Letta Sleeptime | 2026 | 异步记忆维护，184ms/次 |

**关键发现**：无跨 session 学习时，工具执行成功率 72h 内下降 14 个百分点。

#### 后台代理生态

| 项目 | 架构 | 特点 |
|------|------|------|
| Nightcrawler | ~500 行 TS，launchd 崩溃恢复 | 30-60 分钟工作段，8 种终止条件 |
| Claude Code /loop | cron 调度 | 50 并发，3 天过期 |
| Letta Sleeptime | 异步记忆块更新 | 700 token，184ms/次 |
| Google ADK | DatabaseSessionService | checkpoint-and-resume |
| "睡觉时开发" | 新兴实践 | 下班留任务→夜间工作→早上审查 PR |

#### 三层架构模式

所有后台 agent 共享：
1. **接口层** — auth, streaming, 任务提交
2. **持久工作流层** — 持久执行, checkpoint/resume, 状态机
3. **沙箱执行层** — 隔离 VM/容器

#### DeepSeek 角度

**不对称优势**：其他 agent 每次工作段开始都是冷缓存。DeepSeek 缓存跨工作段持续数小时。
- 隔夜工作段成本降低 60-80%
- 每晚 10 个后台任务，总成本 <$1
- 缓存 = 执行连续性的物理载体（类似 hibernation-to-RAM）

---

## 第三部分：收敛分析

### 三条主线

```
收敛 1：免费算力的利用
├── IdleSpec（工具等待 = 免费推测时间）
├── AgentDiet（过期轨迹 = 浪费的 token）
└── DeepSeek 长缓存（状态持久化 = 免费）

收敛 2：从失败中学习（无需训练）
├── Mistake Notebook（结构化失败经验）
├── Experiential Reflective Learning（轨迹反思→启发式规则）
├── MetaClaw（空闲时优化策略）
└── Songline durable claims（天然对齐）

收敛 3：编译而非解释
├── Agent JIT（任务→可执行代码）
├── Plan Caching（相似任务→复用模板）
├── PASTE（可预测下一步→预执行）
└── muscle-mem（精确匹配→直接回放）
```

### DeepSeek V4 的独特优势映射

| DeepSeek 特性 | 启用的技术 | 为什么其他 provider 做不到 |
|--------------|-----------|------------------------|
| 长 TTL prefix cache (小时-天) | 后台代理免冷启动 | Claude/GPT 5 分钟过期 |
| Flash 12x 便宜 | 多路推测、自博弈训练数据 | 推测成本不可忽略 |
| 99.41% cache hit (连续 session) | 第二路推测几乎免费 | 其他 provider 无此命中率 |
| Flash 640x cheaper than GPT-5.5 Pro | 无限自博弈数据生成 | 成本禁止 |

---

## 第四部分：修订版 P3 路线图

### 按 ROI 排序（影响力 × 可行性 / 实施成本）

| 优先级 | 技术 | 核心价值 | 预估 | 依赖 |
|--------|------|---------|------|------|
| **P3-A** | Mistake Notebook | 从失败中学习，持续复利 | 1 天 | 无 |
| **P3-B** | AgentDiet 轨迹精简 | 39-59% token 减少，0 性能损失 | 2-3 天 | 无 |
| **P3-C** | IdleSpec 空闲推测 | 免费算力利用，+9.1% 长任务 | 3-5 天 | P2-11 Shadow Queue |
| **P3-D** | Atropos 模型热切换 | Flash→Pro 自动升级 | 1 周 | P2-14 Task Complexity |
| **P3-E** | Plan-to-Plan 缓存 | -46% 成本, -27% 延迟 | 1-2 周 | trace-store |
| **P3-F** | 后台代理 (Nightcrawler) | "睡觉时开发" | 1 周 | checkpoint 机制 |
| **P3-G** | Online RL (LinUCB) | 越用越懂你 | 1-2 周 | 数据收集 14 天 |
| **P3-H** | Agent JIT Compilation | 10.4x 加速（重复任务） | 2-3 周 | Plan Cache |

### 依赖关系

```
P3-A (Mistake Notebook) ──────────────────────── 独立，立即可做
P3-B (AgentDiet) ─────────────────────────────── 独立，立即可做
P3-C (IdleSpec) ──── 依赖 P2-11 Shadow Queue ─── 已完成
P3-D (Atropos) ───── 依赖 P2-14 Complexity ──── 已完成
P3-E (Plan Cache) ── 依赖 trace-store ────────── 已有
P3-F (Background) ── 依赖 checkpoint 机制 ────── 需新建
P3-G (Online RL) ─── 依赖数据收集基础设施 ────── 需新建
P3-H (Agent JIT) ─── 依赖 Plan Cache ─────────── P3-E
```

---

## 第五部分：关键论文索引

| # | 论文 | 来源 | 日期 | URL |
|---|------|------|------|-----|
| 1 | AgenticCache | MLSys 2026 | 2026.04 | arXiv:2604.24039 |
| 2 | Agentic Plan Caching (APC) | ICML 2025 (Stanford) | 2025.06 | arXiv:2506.14852 |
| 3 | PASTE | 上海交大+微软 | 2026.03 | arXiv:2603.18897 |
| 4 | B-PASTE | 2026.04 | 2026.04 | arXiv:2604.16469 |
| 5 | Temporal Straightening | ICML 2026 (LeCun) | 2026.03 | arXiv:2603.12231 |
| 6 | AgentRM (OS Scheduler) | 2026.03 | 2026.03 | arXiv:2603.13110 |
| 7 | IdleSpec | 2026.05 | 2026.05 | (frontier scout) |
| 8 | AgentDiet | FSE 2026 | 2026 | (frontier scout) |
| 9 | Atropos | ISSTA 2026 | 2026 | (frontier scout) |
| 10 | Agent JIT Compilation | ICML 2026 | 2026 | (frontier scout) |
| 11 | TFlow | 2026.05 | 2026.05 | (frontier scout) |
| 12 | Mistake Notebook Learning | 2026.01 | 2026.01 | (frontier scout) |
| 13 | Experiential Reflective Learning | ICLR 2026 Workshop | 2026 | (frontier scout) |
| 14 | Agent Capsules | 2026.05 | 2026.05 | (frontier scout) |
| 15 | SafeDPO | ICLR 2026 Oral | 2026 | (rl scout) |
| 16 | G-Zero | 2026.05 | 2026.05 | github.com/Chengsong-Huang/G-Zero |
| 17 | RLinf (Cursor Tab 复现) | 清华/无问芯穹 | 2026 | github.com/RLinf/RLinf |
| 18 | SpecAgent | UC Berkeley + AWS | 2025.10 | arXiv:2510.17925 |
| 19 | EfficientEdit | 2025.06 | 2025.06 | arXiv:2506.02780 |
| 20 | Why Agent Caching Fails | 2026.02 | 2026.02 | arXiv:2602.18922 |
| 21 | vCache | ICLR 2026 | 2026 | arXiv:2502.03771 |
| 22 | ALTK-Evolve | IBM | 2026.04 | HuggingFace blog |
| 23 | MetaClaw | 2026.03 | 2026.03 | arXiv:2603.17187 |
| 24 | Claude Dreaming | Anthropic | 2026.05 | (temporal scout) |
| 25 | Cursor Tab RL | Cursor | 2026.02 | cursor.com/blog/tab-rl |

---

## 哲学锚点

> 免费算力的利用 = 虚空不是虚无，是最丰饶的基底。工具等待时间、过期轨迹、缓存 TTL——都是未被利用的虚空。
> 从失败中学习 = 反者道之动。错误不是浪费，是下一次正确的种子。
> 编译而非解释 = 有限规则无限涌现。一旦模式被识别，就不再需要每次重新推理。
> 时域拉直 = 参考系锚定。弯曲的推理轨迹浪费认知能量，拉直后欧氏距离≈测地距离。
