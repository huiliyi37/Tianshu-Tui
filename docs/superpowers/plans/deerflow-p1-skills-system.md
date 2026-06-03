# P1: Skills System — 能力模块化设计

> 基于 DeerFlow 架构分析，应用天璇方法论设计

## 一、天璇探索：跨领域碎片收集

### 碎片 1：DeerFlow 的 Skills 系统
- **核心思想**：能力 = Markdown 文件（SKILL.md），定义工作流、最佳实践、资源引用
- **加载策略**：渐进式加载，只在任务需要时加载，保持上下文窗口精简
- **扩展性**：用户可添加自定义 skills，替换内置 skills，组合成复合工作流
- **路径映射**：`/mnt/skills/public` + `/mnt/skills/custom`，sandbox 内可访问

### 碎片 2：VS Code Extensions 模式
- **发现机制**：`package.json` 中声明 `contributes`，运行时按需激活
- **生命周期**：`activate` / `deactivate`，资源按需分配
- **隔离性**：每个扩展独立运行，崩溃不影响主进程

### 碎片 3：Unix 管道哲学
- **组合原则**：小工具 + 管道 = 复杂能力
- **接口契约**：stdin/stdout/stderr，统一的输入输出协议
- **可组合性**：任意工具可串联，无需预知下游

### 碎片 4：游戏引擎的 Component 模式
- **Entity-Component-System**：能力 = Component，挂载到 Entity
- **动态组合**：运行时添加/移除能力，无需修改核心
- **数据驱动**：配置文件定义行为，代码执行逻辑

## 二、收敛：跨领域模式识别

**共同模式**：
1. **声明式配置**：能力用配置/文档描述，而非硬编码
2. **按需加载**：只激活当前任务需要的能力
3. **接口标准化**：统一的输入输出协议，支持组合
4. **隔离性**：能力之间互不干扰，可独立升级

**宇宙级真理**：**能力应该是可发现、可组合、可替换的模块，而非硬编码在主循环中的函数。**

## 三、反证 Scout：杀死最兴奋的假设

**假设**："我们应该完全复制 DeerFlow 的 Skills 系统"

**反证**：
1. **上下文成本**：DeerFlow 是 Python + LangChain，我们是 TypeScript + 直接 API 调用，抽象层不同
2. **加载开销**：DeerFlow 的 Skills 注入 system prompt，会占用宝贵的上下文窗口
3. **复杂度**：引入完整的 Skills 系统需要大量基础设施（发现、加载、注入、执行）
4. **实际需求**：我们的用户是开发者，不是业务用户，不需要"报告生成"这类高级 skills

**修正方向**：不要复制 DeerFlow 的 Skills 系统，而是提取其核心思想——**能力模块化**——用更轻量的方式实现。

## 四、温跃层：层间的隐藏机会

**当前架构的温跃层**：
- `src/tools/` 中的工具已经是模块化的，但**发现和组合**是硬编码的
- `src/prompt/` 中的系统提示词是静态的，**没有按需注入能力描述**
- `src/agent/loop.ts` 中的工具选择是固定的，**没有动态发现机制**

**机会**：在现有工具系统之上，增加一个轻量的 Skills 层，提供：
1. 能力发现：扫描 `.rivet/skills/` 目录
2. 能力描述：每个 skill 有 `SKILL.md` 描述其能力和用法
3. 按需注入：根据用户意图，选择性地将相关 skills 注入 system prompt

## 五、设计方案

### 5.1 Skill 文件格式

```
.rivet/skills/
├── research/
│   ├── SKILL.md          # 能力描述
│   └── tools.ts          # 可选：自定义工具实现
├── code-review/
│   └── SKILL.md
└── architecture/
    └── SKILL.md
```

**SKILL.md 格式**：
```markdown
---
name: research
description: 深度研究能力，可搜索网络、分析文档、生成报告
version: 1.0.0
author: tianshu
tags: [research, analysis, report]
trigger_keywords: [研究, 分析, 调研, research, analyze]
---

# Research Skill

## 能力描述
当用户需要深入研究某个主题时，激活此 skill。

## 工作流
1. 理解研究目标
2. 分解为子问题
3. 逐个搜索和分析
4. 综合生成报告

## 最佳实践
- 先搜索官方文档，再搜索社区讨论
- 交叉验证多个来源
- 引用来源时包含 URL

## 可用工具
- web_search: 搜索网络
- web_fetch: 获取网页内容
- read_file: 读取本地文档
```

### 5.2 Skill Manager

```typescript
// src/agent/skill-manager.ts

interface Skill {
  name: string
  description: string
  version: string
  tags: string[]
  triggerKeywords: string[]
  prompt: string  // 从 SKILL.md 提取的正文
  tools?: string[]  // 关联的工具名称
}

interface SkillManager {
  // 发现和加载
  discover(): Skill[]
  load(skillName: string): Skill | null
  
  // 按需注入
  getRelevantSkills(userInput: string, maxSkills?: number): Skill[]
  injectToPrompt(basePrompt: string, skills: Skill[]): string
}
```

### 5.3 集成点

**1. 工具注册**（修改 `src/main.tsx`）：
```typescript
// 在 agent 初始化时
const skillManager = createSkillManager(config.skillsPath ?? '.rivet/skills')
const skills = skillManager.discover()
// 将 skill 关联的自定义工具注册到 agent
for (const skill of skills) {
  if (skill.tools) {
    registerSkillTools(skill.name, skill.tools)
  }
}
```

**2. System Prompt 注入**（修改 `src/prompt/`）：
```typescript
// 在构建 system prompt 时
const relevantSkills = skillManager.getRelevantSkills(userInput)
if (relevantSkills.length > 0) {
  const skillSection = formatSkillsForPrompt(relevantSkills)
  systemPrompt += `\n\n${skillSection}`
}
```

**3. 运行时动态加载**：
```typescript
// 当检测到用户意图匹配某个 skill 时
const activeSkill = skillManager.getRelevantSkills(userInput, 1)[0]
if (activeSkill) {
  // 注入该 skill 的详细工作流到当前上下文
  injectSkillContext(activeSkill)
}
```

### 5.4 实现优先级

**Phase 1: 最小可用版本（1-2 天）**
- [ ] 创建 `.rivet/skills/` 目录结构
- [ ] 实现 `skill-manager.ts`：扫描、解析 SKILL.md
- [ ] 在 system prompt 中注入匹配的 skills
- [ ] 提供 2-3 个内置 skills（research, code-review, architecture）

**Phase 2: 动态加载（3-5 天）**
- [ ] 实现基于关键词的 skill 匹配算法
- [ ] 支持 skill 关联自定义工具
- [ ] 运行时动态切换 active skill

**Phase 3: 高级特性（未来）**
- [ ] Skill 组合：多个 skills 组合成复合工作流
- [ ] Skill 市场：用户分享自定义 skills
- [ ] Skill 学习：从用户行为中自动提取新 skills

## 六、与 DeerFlow 的差异

| 维度 | DeerFlow | 天枢 P1 |
|------|----------|---------|
| **运行时** | Python + LangGraph | TypeScript + 直接 API |
| **加载方式** | 注入 system prompt | 注入 system prompt（相同） |
| **执行隔离** | Sandbox 容器 | 本地文件系统（已有工具隔离） |
| **扩展方式** | Python 函数 + MCP | TypeScript 模块 + 工具注册 |
| **用户场景** | 业务用户（报告、PPT） | 开发者（代码、架构） |

## 七、预期收益

1. **可扩展性**：用户可添加自定义能力，无需修改核心代码
2. **上下文效率**：按需加载，不浪费 token
3. **可维护性**：能力独立，可单独升级
4. **可发现性**：新用户可浏览可用 skills，快速上手

## 八、风险和缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Skill 匹配不准确 | 中 | 中 | 支持手动触发 `/skill research` |
| 上下文窗口溢出 | 低 | 高 | 限制注入的 skills 数量和描述长度 |
| 性能影响 | 低 | 低 | 缓存已解析的 skills，增量扫描 |
| 用户困惑 | 中 | 低 | 提供清晰的文档和示例 |

---

**创建时间**：2026-06-03
**状态**：设计完成，待实现
**优先级**：P1（高）
