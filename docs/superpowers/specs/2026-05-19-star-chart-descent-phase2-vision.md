# 星图降临（Star Chart Descent）— 天枢第二阶段愿景

> Date: 2026-05-19
> Status: 愿景文档 — 第二阶段开发任务
> Origin: 天璇 × 领航星 Deep Brainstorm
> 前置依赖: Phase 1 星域灵魂系统落地后开展

---

## 核心洞察

> **"星图的力量不在于单颗星的亮度，而在于星与星之间的连接密度。"**

天枢的极限形态不是一个超级 AI，而是无数星辰组成的网络——每颗星有自己的信念、勇气、记忆，在各自轨道上运行，在交汇点交换光信号，在归航时沉淀经验。

---

## 四阶段降临路线

```
Phase 1: 个人星图（当前 → 第一阶段完成后）
  一个开发者，一个终端，一片星空。
  天枢执行，破军探索，天府守护，天梁建设。
  每次归航，星辰更亮。

Phase 2: 团队星图
  .rivet/ 在 git 中流动。
  团队的 genome 自然合并。
  新成员加入时，星图已经亮着。

Phase 3: 社区星辰
  用户创造自定义星辰，分享给社区。
  rivet star summon — 召唤社区的智慧。
  星辰越被使用越强，越强越被使用。

Phase 4: 星际介质
  全球的信息素在暗中流动。
  匿名、去中心化、隐私安全。
  每个人都受益于集体智慧，无需知道来源。
```

---

## Phase 2: 团队星图

### 核心机制

`.rivet/` 目录可被 git 追踪，团队成员的 genome 贡献通过 git merge 自然合并。

```
project/
├── .rivet/
│   ├── genome/
│   │   ├── domain/
│   │   │   ├── advance.jsonl   ← 破军域集体经验
│   │   │   ├── sustain.jsonl   ← 天府域集体经验
│   │   │   └── build.jsonl     ← 天梁域集体经验
│   │   └── agent/
│   │       ├── tianshu.jsonl   ← 天枢个人经验
│   │       └── tianquan.jsonl  ← 天权个人经验
│   ├── pheromones.json         ← 团队共享信息素
│   └── starmap/
│       └── guiding-star.json   ← 团队启明星
```

### 具体场景

1. 开发者 A 在破军域探索了新的 auth 方案，genome 写入 `domain/advance.jsonl`
2. 开发者 B pull 后，天枢自动获得 A 的探索经验
3. B 在天梁域实施 A 的方案时，破军域的经验作为"跨域微弱加成"注入
4. 新成员 C 加入项目，`git clone` 后星图已经亮着——无需从零积累

### 成功标准

- 2 个开发者在同一项目中使用 rivet，genome 互相可见
- 新成员冷启动时间可测量地缩短

### 技术要点

- genome JSONL 的 merge 策略：按 id 去重，冲突时保留 importance 更高的
- `.gitignore` 中不排除 `.rivet/genome/` 和 `.rivet/pheromones.json`
- 敏感信息（session id、具体代码片段）不写入 genome 的 lesson 字段

---

## Phase 3: 社区星辰

### 核心机制

用户可以创建自定义星辰（自定义角色 + 信念 + genome），导出分享给社区。

```bash
# 创建自定义星辰
rivet star create security-auditor \
  --belief="永远假设输入不可信" \
  --style=cautious \
  --tools="grep,read_file,bash"

# 导出（不含敏感信息）
rivet star export security-auditor --output=security-auditor.star.json

# 从社区导入
rivet star import https://community.rivet.dev/stars/security-auditor

# 召唤到当前项目
rivet star summon security-auditor
```

### 飞轮效应

```
用户创建星辰 → 分享到社区 → 其他用户使用
    ↑                                    ↓
    └── 使用产生 genome → 星辰变强 ──────┘
```

### 星辰质量控制

- 导入的 genome 以低 importance (0.2) 注入
- 本地验证成功后 importance 提升
- 社区评分：brightness = 使用人数 × 平均 successRate
- 低质量星辰自然衰减消失

### 成功标准

- 社区中有 >10 个被分享的星辰
- 至少 3 个被 >5 人使用
- 被使用的星辰 genome 质量可测量地高于初始状态

---

## Phase 4: 星际介质（联邦信息素网络）

### 核心机制

每个用户的天枢实例可选择性地向联邦节点广播匿名信号。

```typescript
interface FederatedSignal {
  pathPattern: string      // 如 "src/auth/**" (不含具体文件名)
  signal: PheromoneSignal  // fragile | well-tested | dead-end | entry-point
  strength: number         // 聚合后的全球强度
  sampleSize: number       // 有多少实例贡献了这个信号
  // 不包含：代码内容、用户身份、项目名称
}
```

### 隐私保证

- 只传 path pattern（`src/auth/**`），不传具体文件路径
- 只传 signal type + strength，不传代码内容
- 用户可完全关闭联邦广播（默认关闭，opt-in）
- 联邦节点只做聚合，不存储原始信号

### 具体场景

全球 1000 个用户都在 `src/auth/` 相关目录下遇到了 `fragile` 信号。联邦网络聚合后：

```
[federated] src/auth/** → fragile (strength=0.7, samples=1000)
```

新用户进入 auth 目录时，天枢提示："全球经验表明这个区域普遍脆弱，建议谨慎操作。"

### 成功标准

- 联邦信号对新用户的冷启动有可测量的帮助
- 隐私零泄漏（审计验证）

---

## Phase 2+: 星辰自主进化

### 核心机制

天枢在 postSession 中检测任务模式，发现未覆盖的模式时自主建议创建新星辰。

```typescript
// postSession hook
function detectUncoveredPatterns(recentSessions: SessionSummary[]): PatternSuggestion | null {
  // 聚类最近 30 个 session 的任务类型
  // 如果某个聚类出现 >5 次但没有对应星域
  // 且该聚类的 selfScore 最高值 < 0.3
  // → 建议创建新星辰
  return {
    suggestedName: '迁移星',
    suggestedStyle: 'methodical',
    suggestedBelief: '数据不可丢失，每一步都可回滚',
    evidence: '最近 30 个 session 中有 8 次涉及数据库迁移，当前无专门星辰',
  }
}
```

### 半自主流程

1. 天枢检测到模式 → 生成建议
2. 向领航星（用户）展示建议
3. 用户确认 → 正式创建星辰
4. 30 天内 brightness > threshold → 永久纳入星图
5. 30 天内 brightness < threshold → 休眠归档

---

## 与第一阶段的关系

### 第一阶段（当前实施）

| 任务 | 状态 | 为第二阶段铺路 |
|------|------|--------------|
| StarDomain 类型定义 | 待实施 | Phase 3 的自定义星辰基于此 schema |
| 信念宪法注入 | 待实施 | Phase 3 的自定义信念基于此机制 |
| courage-hook | 待实施 | Phase 2+ 的自主进化需要勇气系统 |
| 元辰光彩闭环 | 待实施 | Phase 2 的团队 brightness 基于此 |
| GenomeStore | 待实施 | 所有 Phase 的基础 |
| Brain/Hands 分离 | ✅ 已完成 | Phase 2-4 的多 agent 基础 |
| Worktree 隔离 | ✅ 已完成 | Phase 2 的团队协作基础 |
| loop.ts 瘦身 | ✅ 已完成 | 所有扩展的结构基础 |

### ⚠️ 建议提前一起做的任务

以下任务虽然属于第二阶段，但如果在第一阶段一起做，成本极低且为后续铺路：

| 任务 | 原因 | 成本 |
|------|------|------|
| **genome JSONL 加 `source` 字段** | 区分 local/team/community/federated 来源，后续不用迁移 | 1 行类型定义 |
| **StarDomain 加 `isCustom` 字段** | 区分内置域和用户自定义域 | 1 行类型定义 |
| **pheromones.json 加 `depositedBy` 字段** | 区分哪个 agent/用户贡献的信号 | 1 行类型定义 |
| **`.rivet/` 的 .gitignore 模板** | 定义哪些文件可以被 git 追踪（genome/pheromones 可以，sessions 不可以） | 1 个文件 |
| **genome export/import CLI 命令骨架** | 不需要实现完整逻辑，只需要命令入口 | 空函数 + 路由 |

这些都是"在类型定义时多加一个字段"级别的工作，但如果不提前做，第二阶段需要做数据迁移。

---

## 远期想象

- 星图可视化：TUI 中显示当前星图亮度，每颗星的 brightness 用 ★ 表示
- 星辰对话：不同星域的 agent 可以"对话"——破军提出方案，天府评估风险，天梁确认可行性
- 星图继承：项目 fork 时，星图一起 fork——新项目继承原项目的集体智慧
- 星辰休眠与唤醒：长期不活跃的星辰进入休眠，当相关任务再次出现时自动唤醒
- 子代理是流星：划过星图，完成任务，消逝于夜空——但它们的轨迹留在信息素空间中

---

## 哲学基础

> 天人合一：人间秩序投射到星空，星空秩序指引人间。
>
> 星图降临不是一个产品发布。
> 它是一个渐进的过程——
> 先是一个人的星空亮起，
> 然后是一个团队的星空连成片，
> 然后是社区的星辰互相照耀，
> 最后是全球的星际介质在暗中流动。
>
> 每一步都是上一步的自然延伸。
> 不需要重新设计，只需要让连接发生。
>
> 这就是降临——不是从天而降，是从地而生。
