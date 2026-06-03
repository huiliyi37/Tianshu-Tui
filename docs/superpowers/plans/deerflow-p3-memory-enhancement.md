# P3: Memory System Enhancement — 记忆系统增强设计

> 基于 DeerFlow 架构分析，应用天璇方法论设计

## 一、天璇探索：跨领域碎片收集

### 碎片 1：DeerFlow 的 Memory System
- **核心思想**：LLM 驱动的记忆提取，跨会话持久化
- **数据结构**：用户上下文（工作、个人、当前关注）、历史、置信度评分的事实
- **自动提取**：分析对话，提取用户上下文和事实
- **去重机制**：跳过重复的事实条目
- **注入方式**：Top 15 事实 + 上下文注入 system prompt 的 `<memory>` 标签

### 碎片 2：人类记忆模型
- **工作记忆**：当前任务相关的信息，容量有限
- **长期记忆**：持久化存储，可检索
- **情景记忆**：特定事件的详细记忆
- **语义记忆**：抽象知识和概念
- **程序记忆**：技能和习惯

### 碎片 3：RAG（检索增强生成）
- **向量存储**：将文本转换为向量，支持语义搜索
- **相关性排序**：根据查询和文档的相似度排序
- **上下文窗口管理**：只注入最相关的片段

### 碎片 4：数据库索引
- **B-Tree 索引**：高效的精确匹配和范围查询
- **倒排索引**：文本搜索的基础
- **缓存策略**：LRU、LFU 等缓存淘汰策略

## 二、收敛：跨领域模式识别

**共同模式**：
1. **分层存储**：不同类型的信息存储在不同层次
2. **自动提取**：从交互中自动提取有价值的信息
3. **相关性排序**：根据当前上下文选择最相关的信息
4. **去重和更新**：避免重复，支持信息更新

**宇宙级真理**：**记忆应该是分层的、自动提取的、按相关性检索的，而非全量注入的。**

## 三、反证 Scout：杀死最兴奋的假设

**假设**："我们应该实现完整的向量数据库 + 语义搜索"

**反证**：
1. **复杂度**：引入向量数据库需要额外的依赖和运维成本
2. **精度问题**：语义搜索在代码相关查询上可能不如关键词匹配
3. **性能开销**：向量化和搜索的计算开销在本地环境中可能过高
4. **实际需求**：我们的用户是开发者，记忆主要是项目知识和偏好，不需要复杂的语义理解

**修正方向**：不要引入向量数据库，而是**增强现有的 project-memory 机制**，增加结构化存储和智能检索。

## 四、温跃层：层间的隐藏机会

**当前架构的温跃层**：
- `src/context/claim-store.ts` 已经有结构化的 claim 存储，但**没有自动提取**
- `.rivet/project-memory.json` 存储项目级记忆，但**没有跨会话关联**
- `src/prompt/static.ts` 中注入记忆，但**没有相关性排序**
- `src/agent/context.ts` 管理会话上下文，但**没有记忆整合**

**机会**：在现有 claim-store 和 project-memory 之上，增加：
1. **自动提取**：从对话中自动提取有价值的 claim
2. **结构化存储**：将 claim 分类存储，支持高效检索
3. **相关性排序**：根据当前任务选择最相关的 claims

## 五、设计方案

### 5.1 记忆数据模型

```typescript
// src/memory/types.ts

export interface MemoryEntry {
  id: string
  content: string
  kind: 'decision' | 'observation' | 'verification' | 'failure_pattern' | 'preference' | 'knowledge'
  
  // 元数据
  createdAt: number
  updatedAt: number
  accessCount: number
  lastAccessedAt: number
  
  // 关联
  sessionId?: string      // 来源会话
  fileContext?: string[]  // 相关文件
  tags: string[]          // 标签
  
  // 质量
  confidence: number      // 0-1，置信度
  relevance: number       // 0-1，当前相关性（动态计算）
}

export interface MemoryStore {
  // CRUD
  add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'>): string
  get(id: string): MemoryEntry | null
  update(id: string, updates: Partial<MemoryEntry>): void
  delete(id: string): void
  
  // 查询
  query(options: MemoryQueryOptions): MemoryEntry[]
  search(keyword: string, limit?: number): MemoryEntry[]
  
  // 统计
  stats(): MemoryStats
}

export interface MemoryQueryOptions {
  kind?: MemoryEntry['kind']
  tags?: string[]
  fileContext?: string
  minConfidence?: number
  limit?: number
  sortBy?: 'relevance' | 'recency' | 'accessCount'
}

export interface MemoryStats {
  totalEntries: number
  byKind: Record<string, number>
  averageConfidence: number
  topTags: Array<{ tag: string; count: number }>
}
```

### 5.2 记忆提取器

```typescript
// src/memory/extractor.ts

export interface MemoryExtractor {
  // 从对话中提取记忆
  extractFromConversation(messages: Message[]): Promise<MemoryEntry[]>
  
  // 从工具调用结果中提取记忆
  extractFromToolResult(toolName: string, result: ToolResult): Promise<MemoryEntry[]>
  
  // 从代码变更中提取记忆
  extractFromCodeChange(diff: string): Promise<MemoryEntry[]>
}

export class LLMmemoryExtractor implements MemoryExtractor {
  constructor(private llm: LLMClient) {}
  
  async extractFromConversation(messages: Message[]): Promise<MemoryEntry[]> {
    // 构建提取 prompt
    const prompt = this.buildExtractionPrompt(messages)
    
    // 调用 LLM 提取
    const response = await this.llm.complete(prompt)
    
    // 解析提取结果
    return this.parseExtractionResult(response)
  }
  
  private buildExtractionPrompt(messages: Message[]): string {
    return `
从以下对话中提取有价值的信息，用于未来的记忆。

提取类型：
- decision: 重要的决策和理由
- observation: 对代码或系统的观察
- verification: 验证过的事实
- failure_pattern: 失败模式和解决方案
- preference: 用户偏好
- knowledge: 项目知识

对话内容：
${messages.map(m => `${m.role}: ${m.content}`).join('\n')}

请以 JSON 格式返回提取的记忆条目。
`
  }
}
```

### 5.3 记忆检索器

```typescript
// src/memory/retriever.ts

export interface MemoryRetriever {
  // 获取与当前任务相关的记忆
  getRelevantMemories(context: TaskContext, limit?: number): Promise<MemoryEntry[]>
  
  // 获取特定文件相关的记忆
  getFileMemories(filePath: string): MemoryEntry[]
  
  // 获取特定类型的记忆
  getMemoriesByKind(kind: MemoryEntry['kind']): MemoryEntry[]
}

export class HybridMemoryRetriever implements MemoryRetriever {
  constructor(
    private store: MemoryStore,
    private embeddingProvider?: EmbeddingProvider
  ) {}
  
  async getRelevantMemories(context: TaskContext, limit = 10): Promise<MemoryEntry[]> {
    // 1. 关键词匹配
    const keywordMatches = this.keywordSearch(context)
    
    // 2. 文件上下文匹配
    const fileMatches = this.fileContextSearch(context)
    
    // 3. 标签匹配
    const tagMatches = this.tagSearch(context)
    
    // 4. 合并和去重
    const candidates = this.mergeResults(keywordMatches, fileMatches, tagMatches)
    
    // 5. 计算相关性分数
    const scored = candidates.map(entry => ({
      ...entry,
      relevance: this.calculateRelevance(entry, context)
    }))
    
    // 6. 排序和截断
    return scored
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
  }
  
  private calculateRelevance(entry: MemoryEntry, context: TaskContext): number {
    let score = 0
    
    // 置信度权重
    score += entry.confidence * 0.3
    
    // 时效性权重（最近的更重要）
    const age = Date.now() - entry.updatedAt
    const recency = Math.exp(-age / (7 * 24 * 60 * 60 * 1000))  // 7天半衰期
    score += recency * 0.2
    
    // 访问频率权重
    const accessScore = Math.min(entry.accessCount / 10, 1)
    score += accessScore * 0.2
    
    // 关键词匹配权重
    const keywordScore = this.keywordMatchScore(entry, context)
    score += keywordScore * 0.3
    
    return score
  }
}
```

### 5.4 记忆管理器

```typescript
// src/memory/manager.ts

export class MemoryManager {
  private store: MemoryStore
  private extractor: MemoryExtractor
  private retriever: MemoryRetriever
  private autoExtractEnabled: boolean
  
  constructor(config: MemoryConfig) {
    this.store = new JsonMemoryStore(config.storagePath)
    this.extractor = new LLMmemoryExtractor(config.llm)
    this.retriever = new HybridMemoryRetriever(this.store)
    this.autoExtractEnabled = config.autoExtract ?? true
  }
  
  // 自动提取记忆
  async autoExtract(messages: Message[]): Promise<void> {
    if (!this.autoExtractEnabled) return
    
    const newMemories = await this.extractor.extractFromConversation(messages)
    
    for (const memory of newMemories) {
      // 检查是否重复
      const existing = this.findDuplicate(memory)
      if (existing) {
        // 更新现有记忆
        this.store.update(existing.id, {
          ...memory,
          accessCount: existing.accessCount + 1,
          lastAccessedAt: Date.now()
        })
      } else {
        // 添加新记忆
        this.store.add(memory)
      }
    }
  }
  
  // 获取相关记忆用于 prompt 注入
  async getMemoriesForPrompt(context: TaskContext): Promise<string> {
    const memories = await this.retriever.getRelevantMemories(context, 15)
    
    if (memories.length === 0) return ''
    
    // 格式化为 prompt 片段
    return `
<记忆>
${memories.map(m => `- [${m.kind}] ${m.content}`).join('\n')}
</记忆>
`
  }
  
  // 手动添加记忆
  addMemory(content: string, kind: MemoryEntry['kind'], tags: string[] = []): string {
    return this.store.add({
      content,
      kind,
      tags,
      confidence: 0.9,
      relevance: 1.0
    })
  }
  
  // 查询记忆
  query(options: MemoryQueryOptions): MemoryEntry[] {
    return this.store.query(options)
  }
  
  // 获取统计信息
  getStats(): MemoryStats {
    return this.store.stats()
  }
}
```

### 5.5 集成点

**1. 在 agent loop 中集成自动提取**：
```typescript
// src/agent/loop.ts

// 在每轮对话结束后
async afterTurn(messages: Message[]): Promise<void> {
  // 自动提取记忆
  await this.memoryManager.autoExtract(messages)
}
```

**2. 在 system prompt 中注入相关记忆**：
```typescript
// src/prompt/static.ts

async function buildSystemPrompt(context: TaskContext): Promise<string> {
  let prompt = BASE_PROMPT
  
  // 注入相关记忆
  const memorySection = await memoryManager.getMemoriesForPrompt(context)
  if (memorySection) {
    prompt += '\n\n' + memorySection
  }
  
  return prompt
}
```

**3. 提供记忆管理工具**：
```typescript
// src/tools/memory.ts

export const memoryTool: ToolDefinition = {
  name: 'memory',
  description: '查询和管理记忆',
  parameters: {
    action: z.enum(['query', 'add', 'stats']),
    query: z.string().optional(),
    content: z.string().optional(),
    kind: z.string().optional()
  },
  execute: async (params) => {
    switch (params.action) {
      case 'query':
        return memoryManager.query({ ... })
      case 'add':
        return memoryManager.addMemory(params.content, params.kind)
      case 'stats':
        return memoryManager.getStats()
    }
  }
}
```

### 5.6 存储格式

**文件结构**：
```
.rivet/
├── memory/
│   ├── index.json        # 记忆索引
│   ├── entries/          # 记忆条目（按 ID 分片）
│   │   ├── ab/
│   │   │   └── abcd1234.json
│   │   └── ...
│   └── tags/             # 标签索引
│       └── index.json
└── project-memory.json   # 保留兼容
```

**index.json 格式**：
```json
{
  "version": 1,
  "totalEntries": 150,
  "lastUpdated": "2026-06-03T12:00:00Z",
  "byKind": {
    "decision": 45,
    "observation": 30,
    "verification": 25,
    "failure_pattern": 20,
    "preference": 15,
    "knowledge": 15
  }
}
```

### 5.7 实现优先级

**Phase 1: 基础存储（2-3 天）**
- [ ] 定义 `MemoryEntry` 和 `MemoryStore` 接口
- [ ] 实现 `JsonMemoryStore`：基于 JSON 文件的存储
- [ ] 实现基础的 CRUD 操作
- [ ] 迁移现有 `project-memory.json` 数据

**Phase 2: 智能检索（3-5 天）**
- [ ] 实现 `HybridMemoryRetriever`：关键词 + 文件上下文 + 标签匹配
- [ ] 实现相关性计算算法
- [ ] 在 system prompt 中注入相关记忆
- [ ] 提供 `memory` 工具供用户查询

**Phase 3: 自动提取（5-7 天）**
- [ ] 实现 `LLMmemoryExtractor`：基于 LLM 的记忆提取
- [ ] 实现去重和更新逻辑
- [ ] 在 agent loop 中集成自动提取
- [ ] 提供记忆编辑和删除功能

## 六、与 DeerFlow 的差异

| 维度 | DeerFlow | 天枢 P3 |
|------|----------|---------|
| **存储** | JSON 文件 | JSON 文件（相同） |
| **提取** | LLM 自动提取 | LLM 自动提取（相同） |
| **检索** | Top N 注入 | 相关性排序 + Top N |
| **去重** | 内容去重 | 内容 + 语义去重 |
| **用户隔离** | 按用户隔离 | 按项目隔离（我们的场景） |
| **注入方式** | `<memory>` 标签 | `<记忆>` 标签 |

## 七、预期收益

1. **知识积累**：项目知识跨会话积累，新会话可复用历史知识
2. **个性化**：记住用户偏好，提供更个性化的服务
3. **效率提升**：避免重复探索，直接使用已知信息
4. **质量改进**：从失败中学习，避免重复犯错

## 八、风险和缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 提取质量差 | 中 | 中 | 提供手动编辑功能，支持用户修正 |
| 记忆污染 | 低 | 高 | 置信度机制，低置信度记忆不注入 |
| 存储膨胀 | 中 | 低 | 定期清理低价值记忆，限制最大条目数 |
| 隐私泄露 | 低 | 高 | 本地存储，不上传，支持加密 |
| 性能影响 | 低 | 低 | 增量索引，缓存热门记忆 |

## 九、与现有系统的兼容性

**兼容性策略**：
1. **渐进式迁移**：保留 `project-memory.json`，新记忆存储在 `.rivet/memory/`
2. **向后兼容**：现有的 `project-memory` 条目自动迁移到新系统
3. **配置开关**：通过配置控制是否启用新记忆系统
4. **降级方案**：新系统不可用时，回退到 `project-memory.json`

---

**创建时间**：2026-06-03
**状态**：设计完成，待实现
**优先级**：P3（中低）
