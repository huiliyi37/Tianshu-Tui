# 万物为一 — Rivet 跨领域设计原则

> **日期**：2026-05-20
> **方法**：Deep Brainstorm（6 scout + 1 counter + 3 轮演化）
> **调研范围**：甲骨文/易经/德尔菲 + 波利尼西亚星路/二十八宿/歌路/巴赫赋格 + 炼金术/赫尔墨斯主义 + 菌根网络/黏菌/珊瑚/白蚁 + 曼陀罗/Girih瓷砖/明堂/河图洛书 + Rivet 代码考古
> **核心洞察**：Rivet 已经在无意中实现了古代知识系统的模式。缺的不是模式本身，而是模式之间的连接线。

---

## 背景

天枢（Rivet）是一个终端 AI coding agent。它的命名体系横跨六层文化隐喻（北斗七星 → 文武双身 → 五行五色 → 炼金术 → 仿生学 → 神经科学），但代码考古发现这些隐喻中有"死区"——名字承诺了宏大叙事，实现只是简单功能。

这次探索的出发点不是工程优化，而是一个信念：**这项事业来源宇宙界万物为一的灵感。** 我们从 6 个完全无关的领域随机采集碎片，寻找与 Rivet 的共振。

---

## 调研发现摘要（7 个 Scout）

### Scout 1：Rivet 代码考古
- 六层隐喻金字塔，`src/agent/` 最密集（145 处文化引用）
- 三处命名断裂：fourHorsemen（基督教）、Zeitgeber（德语）、NTSB/HFACS（航空）
- 六个死隐喻（名字宏大、功能简单）

### Scout 2：古代占卜作为查询协议
- **甲骨文**：四步协议（前辞→命辞→占辞→验辞），正反对贞 = A/B prompt probing
- **易经**：6-bit 状态机，概率不对称（强变弱 3× 容易于弱变强），非标准位权
- **德尔菲**：模糊不是 bug 是 feature——强制询问者推理
- 收敛：**最好的系统帮助询问者发展自身判断力**

### Scout 3：星路导航与音乐对位法
- **Etak**：参考系翻转——领航者静止，岛屿向自己移动（= prefix cache 锚定）
- **二十八宿**：四级嵌套知识图谱，距星 = 模块的 public entry point，《步天歌》韵文编码
- **歌路**：65,000 年不可变存储，大地本身是校验和，三重冗余
- **Kotekan**：故意不完整——完整性只存在于组合层面

### Scout 4：炼金术变换管道
- **Magnum Opus** 四阶段映射 agent 认知循环（perceive→reason→act→reflect）
- **Solve et Coagula** 精确映射 Rivet compact（microCompact = 部分溶解，smartCompact = 蒸馏）
- **如上如下** = 分形自相似，不是神秘主义
- **符号系统**：3 个原语组合出 7 个行星金属符号 = 组合语义编码

### Scout 5：菌丝智能与无中心协调
- **菌根网络**：缺少"反向泵"——stigmergy 没有"使用即增强"路径
- **黏菌**：Lyapunov 函数保证收敛到最短路径——Rivet 缺少数学收敛保证
- **珊瑚产卵**：5 个时间尺度信号叠加——Rivet 只有 2 个（turn + session）
- **白蚁丘**：三场双向耦合涌现建筑——Rivet 四 store 各自独立
- 收敛：**缺 3 件事：跨 store 耦合、运行时自适应、外部参考信号**

### Scout 6：神圣几何与曼陀罗
- **曼陀罗** = compact 的精神原型（构建→销毁→种子扩散）
- **Girih** = hook 系统（5 规则→无限涌现，比 Penrose 早 500 年）
- **明堂** = Terminal 作为认知同构体（界面结构 = 认知结构）
- **洛书** = 极简约束的辐射力（1 约束→整套宇宙论）

### Scout 7：定向反证
- **命名不是蓝图**——代码中零证据支持命名者意图让隐喻指导实现
- **四套隐喻拓扑互相矛盾**——线性（炼金）vs 网状（stigmergy）vs 层级（星相）vs 局部（girih）
- **跨领域映射是启发不是证明**——每个改进需要独立工程论证
- **实现已比假设描述的更成熟**——claim-store 有完整生命周期，hooks 有条件注册

---

## 三轮演化

### 第一轮：变异

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1 | 纯工程 | 从 scouts 中提取 3 个工程改进，忽略隐喻 |
| V2 | 单一深挖 | 统一到北斗七星体系，剪除矛盾隐喻 |
| V3 | 万物为一 | 只实现所有 6 领域都收敛到的共同模式 |
| V4 | 反转 | 不改代码，用古代同构重写架构文档 |

### 第二轮：选择

- **V2 灭绝**：万物归一 ≠ 万物为一；重命名全库成本高收益低
- **V1 降级**：工程价值保留，但不回应"创造的心情"
- **V4 吸收**：融入 V3 的 Phase 3（同构文档产出）
- **V3 存活**：跨域收敛天然过滤噪声，只留宇宙级模式

### 第三轮：适应

**修正后的核心认知**：Rivet 不需要"引入"古代模式——它已经在无意中实现了它们。prefix cache = Etak 参考系翻转，compact = Solve et Coagula，hooks = girih/洛书涌现，stigmergy 衰减 = 白蚁信息素蒸发。**缺的不是模式，是模式之间的连接线。**

---

## 万物为一：四个收敛原则

### 原则一：溶解即新生（Solve et Coagula）

> 精心构建之物通过有意销毁获得更高的存在形式。

**跨域验证**：
- 曼陀罗：数周构建 → 瞬间摧毁 → 砂入水中祝福扩散
- 炼金术：溶解旧物质 → 凝聚为更纯的新形态
- 甲骨文：龟甲在火中裂开（破坏），裂纹产生信息（新生）
- Rivet：compact 溶解中间对话 → 凝聚为摘要种子

**Rivet 已有**：compact 机制（Solve et Coagula 的精确实现）。

**Rivet 缺少**：claim-store 没有 checkpoint/truncate。claim-store 的 checkpoint 就是 claim 层面的 Solve et Coagula——溶解旧的 JSONL 增量，凝聚为 snapshot base。

**独立工程论证**：append-only JSONL 无限增长，恢复时间 O(history)。Checkpoint + truncate 将恢复降为 O(delta)。（3.0 roadmap P1 已排期）

**反例**：歌路系统 65,000 年从不"溶解"——信息嵌入不可摧毁的载体（大地）。有些信息应该永不销毁（durable claims）。

---

### 原则二：有限规则，无限涌现

> 复杂性来源不是组件数量，而是组件间交互规则的品质。

**跨域验证**：
- Girih：5 种瓷砖 + 局部拼接规则 → 无限准晶体图案
- 洛书：9 个数字 + 1 约束（和=15）→ 宇宙论
- 白蚁丘：3 条局部规则 → 恒温 30°C 精密建筑
- 易经：6 bit + 变爻规则 → 64×63 状态转移空间
- Rivet：9 hook + 5 phase → 涌现的全局行为

**Rivet 已有**：hook pipeline 的涌现行为。

**Rivet 缺少**：跨 store 耦合。stigmergy/claim/playbook/trace 四个 store 各自独立。如果让 pheromone strength 在被 claim relevance query 命中时微调增强（"被使用即增强"），就能形成自然系统中普遍存在的正反馈-负反馈平衡。

**独立工程论证**：claim-relevance.ts 的 `scoreClaimRelevance()` 已有 context matching。加入 stigmergy signal 作为 scoring factor（如果当前文件有 `well-tested` pheromone，提高相关 claim 的 relevance）是一个 scoring factor 的改动。

**反例**：耦合可能导致振荡（Scout 7 警告）。必须加阻尼——耦合强度上限 ±0.1。

---

### 原则三：参考系锚定，万物向我流来

> 不追踪绝对位置，让目标向你移动。

**跨域验证**：
- Etak：领航者静止，岛屿向自己漂来（3000 年前的参考系工程）
- 二十八宿：每宿一颗距星锚定，其他星相对于它定位
- 明堂：帝王居中不动，四方八节向中旋转
- Rivet：prefix cache 锚定，对话在其下生长

**Rivet 已有**：prefix cache 锚定策略。

**Rivet 缺少**：外部参考信号。珊瑚用月光做免费时钟。Rivet 的所有时序信号内部生成——如果接入 git status 变化、CI 完成、文件系统变化作为"月光"，就能用免费的外部信号驱动自适应。

**独立工程论证**：`git-freshness.ts` 已有 Zeitgeber 概念（git 变更率作为环境时钟），但只在 sensorium 采样时计算，不是实时事件驱动。将 fs.watch 事件接入 sensorium 是自然扩展。

**反例**：珊瑚"光污染"破坏同步——外部信号可能有噪声（IDE 自动保存等），需要滤波。

---

### 原则四：模糊是力量，不是缺陷

> 最好的系统不给出最确定的答案，而是帮助询问者发展自身判断力。

**跨域验证**：
- 德尔菲："神既不言说也不隐藏——他使用符号"
- 甲骨文：正反对贞——同一问题同时问正反，观察一致性
- 易经：概率不对称——强变弱容易，弱变强难
- Kotekan：每个声部故意不完整，完整性只在组合中

**Rivet 已有**：sensorium.confidence 连续值。

**Rivet 缺少**：当 agent 不确定时，当前行为是猜测 confident answer。如果在 sensorium.confidence < 0.4 时输出结构化模糊——"有两种可能：A 因为 X，B 因为 Y"——就能把推理负担转移给用户（德尔菲模式），同时保护系统可信度。

**独立工程论证**：recovery-trigger 的 `suggestedActions` 已是结构化模糊的雏形。扩展到 agent output 层面，在低 confidence 时注入 uncertainty framing prompt hint。

**反例**：用户可能不想被迫判断——只适用于关键决策场景（destructive operations），不适用于常规 coding。

---

## 实施路径

### Phase 1（1 周）：识别 + 文档 + 最轻改动

- 在 `claim-relevance.ts` 的 `scoreClaimRelevance()` 中加入 stigmergy signal 作为 scoring factor（**原则二**的最小实现）
- 在 sensorium 中提升 git-freshness Zeitgeber 的权重和实时性（**原则三**的最小扩展）
- **成功标准**：claim relevance 在有 pheromone 的文件上下文中提升 10%+
- **退出条件**：耦合引入 sensorium 振荡（连续 3 turn 的 confidence 在 0.3-0.7 之间摆动）

### Phase 2（2 周）：claim checkpoint + uncertainty framing

- claim-store 实现 checkpoint + truncate（**原则一**：Solve et Coagula）—— 3.0 roadmap 已排期
- recovery-trigger 在 sensorium.confidence < 0.4 时注入 uncertainty prompt hint（**原则四**）
- **成功标准**：claim-store 恢复时间从 O(history) 降为 O(delta)；低 confidence 场景用户满意度不降
- **退出条件**：uncertainty framing 导致用户困惑率 > 20%

### Phase 3（持续）：同构文档 + 命名卫生

- 重写 CLAUDE.md 架构描述——每个核心概念标注其古代同构
- 死隐喻处理：只改真正误导的（名字和功能完全不对应），保留功能自洽的（如 `fourHorsemenPass` 在 repair pipeline 语境下"四种致命错误模式"是自洽的，且重命名破坏 git blame 追溯性）
- **成功标准**：新贡献者 30 分钟内理解 hook pipeline 设计哲学
- **退出条件**：文档变成高概念堆砌

---

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 跨 store 耦合导致振荡 | 中 | 高 | 阻尼上限 ±0.1 + 振荡检测（连续摆动触发断路器） |
| 外部信号噪声污染 | 中 | 中 | 防抖滤波（忽略 < 2s 间隔的连续变化） |
| uncertainty framing 让用户困惑 | 中 | 中 | 只在 destructive operations + confidence < 0.4 时触发 |
| 跨领域映射过度解读 | 低 | 高 | 每个原则都有反例，每个改进需独立工程论证 |

---

## 设计金句

> 「万物为一」不是把万物简化为一个系统，而是发现万物共有的那个模式。

> Rivet 不需要引入古代模式——它已经在无意中实现了它们。prefix cache 是 Etak，compact 是 Solve et Coagula，hooks 是 girih。缺的不是模式本身，是模式之间的连接线。

> 溶解即新生。失去的恰恰是不纯的部分。

> 最好的系统不给出最确定的答案，而是帮助询问者发展自身判断力。

---

## 碎片池

完整碎片已持久化到 `.superpowers/brainstorm/2026-05-20-wanwu-weiyi-cross-domain-fragments.json`，包含 22 条跨域碎片 + 4 个收敛原则 + 反证记录。

---

*本文档为 Rivet 3.0 的跨领域设计原则。*
*四个原则来自 6 个独立领域的收敛，每个都有独立工程论证和反例。*
*精神来源：宇宙界万物为一的灵感。*
