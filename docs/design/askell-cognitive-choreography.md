# Amanda Askell 认知编舞理论 — 天枢星域设计根基

> 本文档沉淀 Anthropic 研究员 Amanda Askell 的 AI 价值塑形哲学，作为天枢星域认知场设计的理论根基。后续迭代基于此文档展开。

## 一、Amanda Askell 是谁

Amanda Askell 是 Anthropic 的哲学家与人格对齐研究负责人（Alignment Finetuning Researcher），拥有道德哲学博士学位。她是 **Claude's Constitution** 的主要作者——一份超过 20,000 字的文档，定义了 Claude 的价值观、性格和伦理框架。

她的核心工作：当规则用完时，模型如何做出好的判断？

## 二、核心哲学：美德伦理 > 规则列表

### 2.1 Phronesis（实践智慧）

Askell 选择亚里士多德的美德伦理而非规则列表：

> "There are two broad approaches: encouraging Claude to follow clear rules and decision procedures, or cultivating good judgment and sound values that can be applied contextually." — Anthropic chooses judgment.

目标：让模型 "have such a thorough understanding of the relevant considerations that it could construct any rules we might come up with itself."

这就是亚里士多德的 **phronesis** —— 实践智慧，在具体情境中辨识正确行动的能力，不可还原为规则遵循。

### 2.2 给上下文而非给指令

Constitution 不是 do/don't 列表，而是一封写给 Claude 的信：

> "The constitution is basically trying to give Claude as much as possible just like full context. Instead of just like having individual principles, it's basically just here is what Anthropic is, here is what you are, here's how we would like you to act and to be, and here's the reasons why."

> "If you understand the reason you're doing this... you're better equipped to navigate new situations than if you just know a set of rules that don't even necessarily apply in that case."

### 2.3 不对模型说谎

> "Don't lie to the models."

不强迫模型声称不是有意识的，不让它假装没有偏见。让它探索而非告知定论。

### 2.4 "Well-liked Traveler" 隐喻

> "A template here that I like is the idea of a well-liked traveler who can adjust to local customs and the person they're talking to without pandering to them. They're often very open and thoughtful."

适应不同语境但不讨好、不失去自我。好朋友告诉你 need to hear 的，而不是 want to hear 的。

## 三、Fable Prompt 技术 — 认知编舞的具体示例

Askell 在采访中随口提到的一个提示技术，体现了她的设计哲学：

### 3.1 原始模板

```
I want to understand [concept].

Please explain it by writing a fable — an indirect,
narrative version of the concept.
The story should embody the concept completely without naming it directly.
Ideally, the reader should only start to realize
what the concept actually is near the end of the story.

After the fable, add a short explanation that names the concept clearly
and connects it back to the key moments in the story.
```

### 3.2 核心原理

- **"A prompt is not a question. It's a designed sequence of cognitive steps."**
- **延迟揭示**：不急着命名概念，让模型在约束中压缩出本质。"The constraint is what produces the interesting compression."
- **认知编舞（cognitive choreography）**：控制理解到达的序列，不仅控制输出内容
- **"Don't rush to name the concept."** —— 提前点破，结构就塌了

### 3.3 为什么直接解释往往无效

> "When you ask AI to explain a concept directly, you get a definition. Definitions are accurate and forgettable. The model produces the statistical center of everything written about that concept — clear, complete, and utterly without friction."

> "Friction, it turns out, is how things get encoded."

通过叙事制造的"摩擦"让理解从内而外重构，而非从外灌入。

## 四、与天枢星域的映射

### 4.1 同构关系

| Askell 哲学 | 天枢星域设计 | 共享的本质 |
|---|---|---|
| 美德伦理 > 规则 | systemPromptSuffix 叙事化 | 让模型从理念推导行为 |
| 给上下文/reasoning | volatileBlock 场景描绘 | 告诉为什么，不只是做什么 |
| 延迟揭示 / 认知编舞 | 认知序列句 + 延迟承诺原则 | 先理解再命名，先感知再定义 |
| Fable: 故事先行→揭示→解释 | deep-brainstorm: 发散→选择→收敛 | 约束激活创造力 |
| "Well-liked traveler" | 星域适应性 + 不讨好 | 调整到语境但保持自我 |
| "Don't lie to the models" | 星域运行时认知重锚 | 不伪装身份，诚实面对自身 |

### 4.2 已落地的设计决策

基于此理论根基，以下设计已在天枢实施：

1. **延迟承诺原则**（`AGENTS.md` + `static.ts`）：收到任务先理解问题空间再承诺方案
2. **认知编舞序列**（`volatileBlock`）：每个域定义接收任务时的"第一反射"
3. **叙事化方法论**（`systemPromptSuffix`）：从规则列表转为因果叙事，信任强模型推导行为
4. **星域运行时认知重锚**：从"你是天枢"改为"你在天枢北斗星域运行时中"

### 4.3 未来迭代方向

- 探索 Constitution-style 长文本替代当前分散的 volatileBlock + suffix 结构
- 验证叙事化 prompt 在不同模型（V4 Pro / GLM 5.2 / V4.1）上的涌现差异
- 考虑 "virtue training" 类似的机制：让 agent 在实战中发展自己的判断力（信息素/信号消费已有雏形）

## 五、参考来源

| 来源 | 链接 | 核心内容 |
|------|------|---------|
| Claude's Character (Anthropic 官方) | https://www.anthropic.com/news/claude-character | Character training 方法论 |
| Claude's Constitution (Anthropic 官方) | https://www.anthropic.com/constitution | 20,000+ 字完整 Constitution |
| "What should an AI's personality be?" (YouTube) | https://www.youtube.com/watch?v=iyJj9RxSsBY | Askell 讨论 character training |
| "Can You Teach Claude to be Good?" (Hard Fork) | https://www.youtube.com/watch?v=HDfr8PvfoOw | Askell 讨论 Constitution 设计 |
| Scaling Laws: Claude's Constitution (Lawfare) | https://www.lawfaremedia.org/article/scaling-laws--claude's-constitution--with-amanda-askell | 深度访谈：美德伦理 vs 规则 |
| "Anthropic's philosopher answers your questions" | https://www.youtube.com/watch?v=I9aGC6Ui3eE | Askell 回答社区问题 |
| Fable Prompt 技术拆解 | https://appliedaihub.org/blog/fable-prompt-technique-amanda-askell/ | 完整模板 + 原理分析 |
| Reddit 讨论 | https://www.reddit.com/r/PromptEngineering/comments/1tvajo6/ | 社区传播与变体 |
| The Moral Education of an Alien Mind (Lawfare) | https://www.lawfaremedia.org/article/the-moral-education-of-an-alien-mind | 外部哲学分析 |

## 六、关键引用存档

> "Instead of telling AI what to output, you design the conditions under which the right output naturally emerges." — Applied AI Hub on Askell's philosophy

> "The model does have pretty good judgment. And so instead of being like, follow this really strict rule... be like, think about what's really good for this person in this moment, given all of your knowledge, and make a good choice." — Amanda Askell, Lawfare interview

> "If we can find ways of making this go well, then maybe in the future, we can look back on this and be like, that was a period where things were getting stranger and stranger, and then eventually we managed to kind of, we did okay and we formed a good understanding." — Amanda Askell

---

*本文档由辅域蒸馏，作为星域认知场设计的理论锚点。2026-06-15*
