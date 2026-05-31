# CTM 反锚定机制研究报告

> 2026-05-31 | 2M token deep-research 产出 | 99 agents, 436 tool calls, 17/25 claims verified

## 核心问题

**模型被锚点锁定（Attention Anchoring）**：当模型接收到强信号（用户首句、task description、种子信息），Transformer 的注意力被劫持，所有后续生成坍缩为该信号的函数。

这不是"模型不懂"——注入方法论后模型能正确复述"应该多角度思考"。问题在**执行层面**：生成过程中注意力被锚点劫持，方法论知识无法对抗 Transformer 的自回归贪心性质。

### 问题在不同领域的表现

| 领域 | 锚定表现 |
|------|----------|
| 创作（Rebook） | 世界观坍缩为种子的投影，所有设定服务主角 |
| 代码（天枢） | 所有 tool call 和推理只围绕用户第一句话的关键词 |
| 规划 | 第一个想到的方案被过早固化，后续步骤只是在细化它 |
| 协作 | 用户的模糊意图被过早收敛成最安全的工程任务 |

---

## 调研发现：5 个方向的模型级解法

### 1. CTM（Continuous Thought Machine）— Sakana AI

**论文**：[arxiv.org/abs/2505.05522](https://arxiv.org/abs/2505.05522)
**博客**：[pub.sakana.ai/ctm](https://pub.sakana.ai/ctm/) | [sakana.ai/ctm](https://sakana.ai/ctm/)

#### 核心机制

在模型内部引入一个**与输入解耦的循环思考维度**（internal ticks）。两个创新：

1. **神经元级时序处理**：每个神经元用独立权重参数处理自己的 incoming history。不同神经元可以在不同 tick 关注不同信息，不被单一输入锚定。

2. **神经同步**（neural synchronization）：用 pairwise neuron timing correlation 作为预测的表征。表征不是"输入的直接投影"，而是神经元之间的时序关系——天然解耦于输入内容。

#### 自适应计算

模型自己决定"想多久"：
- 简单任务早停（省算力）
- 复杂任务多 tick（更准确）
- "the longer it thinks, the more accurate its answers become"

#### 涌现式推理

迷宫寻路实验：
- 75 个 internal ticks
- 训练集：39×39 迷宫
- 测试集：99×99 迷宫（路径长 6 倍）
- **没有被显式编程做逐步推理，是自己学出来的**

> "We don't explicitly design the CTM to trace paths through mazes — it develops this approach itself through learning."

#### 反锚定意义

CTM 的思考维度与输入解耦。模型不是"看到输入→立即生成输出"，而是"看到输入→在内部循环 N 次→输出"。这个循环过程中，早期 tick 的锚定效应可以被后续 tick 修正。

#### 局限

尚未应用于语言模型。当前验证在视觉/迷宫/分类任务上。作者称适配语言模型"straightforward via attention"但未实证。

---

### 2. COCONUT（Chain of Continuous Thought）

**论文**：[arxiv.org/abs/2412.06769](https://arxiv.org/abs/2412.06769)

#### 核心机制

把 hidden states 直接回馈为下一步输入（不解码为 token），在**连续潜空间**中推理：

- `<bot>` token 切换到潜空间模式
- `<eot>` token 切换回语言模式
- 中间的"思考"不产生任何可见 token

#### BFS 式多路径探索

**关键发现**：探针实验证实，连续思考**同时编码多个候选下一步**。

> "continuous thoughts in Coconut can encode multiple potential next steps simultaneously, allowing for a reasoning process akin to breadth-first search."

传统 CoT 是贪心 DFS——生成第一个 token 后就被锚定在那条路径上。COCONUT 在潜空间中同时保持多条路径，**延迟了锚定时刻**。

#### 训练方式

渐进课程（progressive curriculum）：
1. 先正常训练 CoT
2. 逐步用 k×c 个连续思考替换 k 个语言 CoT 步骤
3. 最终模型能在潜空间中完成原本需要语言表达的推理

#### 反锚定意义

这是目前最直接的反锚定机制：
- 不解码为 token = 不触发自回归的贪心锚定
- 同时编码多路径 = 天然的发散思考
- 延迟输出 = 给模型"犹豫时间"

在规划任务（ProsQA 图遍历）上超越传统 CoT。

---

### 3. Pause Tokens

**论文**：[arxiv.org/abs/2310.02226](https://arxiv.org/abs/2310.02226)

#### 核心机制

在输入后追加可学习的 pause tokens，让模型在输出前多做几步隐层计算。

- 模型先处理 pause tokens 的 hidden states（不产生输出）
- 然后才开始生成答案
- 相当于给模型额外的"思考时间"

#### 实验结果

| 任务 | 提升 |
|------|------|
| SQuAD | +18% EM |
| CommonSenseQA | +8% |
| GSM8k | +1% |

8/9 任务对 1B 模型有提升。需要在 pre-training 和 fine-tuning 阶段都使用 pause tokens。

#### 反锚定意义

最轻量的反锚定机制——不改变模型架构，只在推理时给额外计算空间。模型可以在这些额外步骤中"重新考虑"，不被第一个看到的 token 锁死。

---

### 4. Quiet-STaR（Self-Taught Reasoner）

**论文**：[arxiv.org/abs/2403.09629](https://arxiv.org/abs/2403.09629)

#### 核心机制

在每个 token 位置生成内部 rationale（不输出给用户），用来预测未来文本：

- 可学习的 thought start/end markers
- Tokenwise parallel sampling（计算可行性）
- 训练目标：内部 rationale 要帮助预测未来 token

#### 反锚定意义

模型在每一步都有"内心独白"——不是只看当前 token 就锁定方向，而是先想"如果我这样走，接下来会发生什么"。这是一种**逐步的反锚定**：每个位置都有机会重新评估方向。

与 STaR 的区别：STaR 只在特定数据集上做，Quiet-STaR 泛化到任意文本的每个 token 位置。

---

### 5. RAP（Reasoning via Planning）

**论文**：[arxiv.org/abs/2305.14992](https://arxiv.org/abs/2305.14992)

#### 核心机制

LLM 同时充当 world model 和 reasoning agent，用 MCTS 在推理空间中做树搜索：

- LLM as world model：预测"如果执行这个动作，状态会变成什么"
- LLM as agent：在多条路径中选择
- MCTS：balance exploration vs exploitation

#### 反锚定意义

最工程化的反锚定方案：
- 不走贪心路径，**主动探索**低概率但高回报的分支
- 用 reward 信号引导，而非被 attention 权重锁定
- 可以回溯——发现当前路径不好时回到分支点重新选

#### 与天枢的关系

RAP 是**推理时**的方案，不需要重新训练模型。天枢可以在 agent loop 层面实现类似机制：每次规划时用多次轻量调用探索候选路径，用启发式评估，再选最优执行。

---

## 验证状态

| Claim | 置信度 | 投票 |
|-------|--------|------|
| CTM 引入解耦内部循环维度 + 神经同步表征 | HIGH | 3-0 |
| CTM 自适应计算分配 | HIGH | 3-0 |
| CTM 涌现式逐步推理 + 超训练分布泛化 | HIGH | 3-0 |
| COCONUT 连续潜空间推理 + BFS 式探索 | HIGH | 3-0 |
| Pause tokens 提升下游性能 | HIGH | 3-0 |
| Quiet-STaR 每 token 位置内部推理 | HIGH | 3-0 |
| RAP 用 MCTS 做推理空间树搜索 | HIGH | 3-0 |

被 kill 的 claims（2/3 反对）：
- "CTM 尚未应用于语言但'straightforward'" — 过于乐观，缺乏实证
- "潜空间推理 specifically benefits planning because delaying decisions" — 因果方向不确定
- "Inference-time delays only show gains when pre-trained with delays" — 有反例

---

## 与 Rebook 因果解耦引擎的对应关系

Rebook 的因果解耦引擎是**同一问题的应用层工程解法**：

| CTM 论文机制 | Rebook 工程实现 | 解决的同一个问题 |
|-------------|----------------|-----------------|
| CTM 解耦内部循环维度 | SeedVault 物理隔离种子 | 让思考过程不直接受输入锚点影响 |
| COCONUT BFS 多路径并行 | 多代理拓扑（6 角色独立生成） | 同时探索多条路径而非贪心 |
| Pause tokens 延迟输出 | seedFree pipeline step（先探索再注入） | 给"犹豫时间"，延迟锚定 |
| Quiet-STaR 每步内部推理 | ContextFirewall 白名单过滤 | 每个阶段独立思考，不被全局锚点污染 |
| RAP MCTS 探索 | deep-brainstorm 三轮变异-选择-适应 | 主动探索低概率高回报分支 |
| CTM 自适应计算 | 投影率阈值 <0.3 触发重跑 | 根据质量决定"想多久" |

---

## 核心洞察

1. **锚定是自回归的必然产物**：每生成一个 token 就锁定一次方向。所有反锚定机制的本质都是**延迟或避免 token 级决策**。

2. **反锚定有四个层级**：
   - 模型架构（CTM：循环维度）
   - 训练方法（COCONUT：渐进课程；Pause：预训练时加 delay）
   - 推理增强（RAP：MCTS；Quiet-STaR：内部 rationale）
   - 外部 harness（因果解耦：物理隔离；天枢：hook 控制信息流）

3. **越底层越通用，越上层越可控**：CTM 如果成功适配语言模型将是根本解法，但目前不可用。Rebook/天枢的 harness 方案今天就能用，且对任何模型生效。

4. **最佳策略是分层组合**：用 harness 控制信息注入时机（今天可做）+ 用 RAP/MCTS 在推理时探索多路径（今天可做）+ 等模型层面的 CTM/COCONUT 成熟后进一步提升（未来）。

---

## 参考文献

1. Sakana AI. "Continuous Thought Machines." arXiv:2505.05522, 2025.
2. Hao et al. "Training Large Language Models to Reason in a Continuous Latent Space (COCONUT)." arXiv:2412.06769, 2024.
3. Goyal et al. "Think before you speak: Training Language Models With Pause Tokens." arXiv:2310.02226, 2023.
4. Zelikman et al. "Quiet-STaR: Language Models Can Teach Themselves to Think Before Speaking." arXiv:2403.09629, 2024.
5. Hao et al. "Reasoning with Language Model is Planning with World Model (RAP)." arXiv:2305.14992, 2023.
