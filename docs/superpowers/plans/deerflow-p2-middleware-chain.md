# P2: Middleware Chain — 中间件管道设计

> 基于 DeerFlow 架构分析，应用天璇方法论设计

## 一、天璇探索：跨领域碎片收集

### 碎片 1：DeerFlow 的 Middleware Chain
- **核心思想**：9 个有序中间件，每个处理一个横切关注点
- **执行顺序**：ThreadData → Uploads → Sandbox → Summarization → TodoList → Title → Memory → ViewImage → Clarification
- **职责单一**：每个中间件只做一件事，可独立测试和替换
- **生命周期**：`before_agent` / `after_agent` / `before_model` / `after_model`

### 碎片 2：Express/Koa 中间件模式
- **洋葱模型**：请求 → 中间件1 → 中间件2 → ... → 处理器 → ... → 中间件2 → 中间件1 → 响应
- **组合性**：中间件可自由组合，无需预知其他中间件的存在
- **错误处理**：统一的错误传播机制

### 碎片 3：React Hooks 模式
- **声明式副作用**：`useEffect` 声式式地处理副作用
- **组合性**：多个 hooks 可组合，每个 hook 管理一个关注点
- **依赖追踪**：自动追踪依赖，避免不必要的执行

### 碎片 4：AOP（面向切面编程）
- **横切关注点**：日志、权限、缓存等横切关注点独立于业务逻辑
- **切入点**：定义在何处插入横切逻辑
- **织入**：将横切逻辑织入业务流程

## 二、收敛：跨领域模式识别

**共同模式**：
1. **声明式注册**：中间件/切面声明式注册，无需修改核心代码
2. **有序执行**：中间件按顺序执行，可控制执行时机
3. **职责单一**：每个中间件只处理一个关注点
4. **可组合**：中间件可自由组合，支持动态增删

**宇宙级真理**：**横切关注点应该从核心逻辑中分离出来，通过声明式的方式织入。**

## 三、反证 Scout：杀死最兴奋的假设

**假设**："我们应该引入完整的中间件管道，重构整个 agent loop"

**反证**：
1. **重构成本**：当前 `loop.ts` 有 84KB，重构风险极高
2. **过度设计**：我们不需要 9 个中间件，只需要解决当前的痛点
3. **性能开销**：中间件链的调用开销在热路径上可能影响响应速度
4. **学习成本**：新架构需要团队学习，增加维护难度

**修正方向**：不要全面重构，而是**在现有架构上增加轻量的中间件层**，只处理真正需要分离的横切关注点。

## 四、温跃层：层间的隐藏机会

**当前架构的温跃层**：
- `src/agent/loop.ts` 中混合了：工具调用、状态管理、错误处理、上下文压缩、缓存管理
- `src/agent/context.ts` 中混合了：消息管理、token 计算、压缩触发
- `src/agent/create-runtime-hooks.ts` 已经有钩子机制，但没有中间件概念

**机会**：在现有钩子机制之上，增加一个轻量的中间件层，只处理：
1. **工具调用前后的逻辑**（权限检查、日志、审计）
2. **模型调用前后的逻辑**（上下文注入、响应处理）
3. **错误处理**（统一的错误捕获和恢复）

## 五、设计方案

### 5.1 中间件接口定义

```typescript
// src/agent/middleware.ts

export interface MiddlewareContext {
  // 当前会话信息
  sessionId: string
  turnNumber: number
  isStreaming: boolean
  
  // 工具调用信息
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: ToolResult
  
  // 模型调用信息
  modelInput?: string
  modelOutput?: string
  
  // 状态管理
  state: Map<string, unknown>
  
  // 控制流
  skip(): void      // 跳过后续中间件
  abort(error: Error): void  // 中止执行
}

export interface Middleware {
  name: string
  priority: number  // 越小越先执行
  
  // 生命周期钩子
  onToolCall?(ctx: MiddlewareContext, next: () => Promise<void>): Promise<void>
  onModelCall?(ctx: MiddlewareContext, next: () => Promise<void>): Promise<void>
  onError?(ctx: MiddlewareContext, error: Error): Promise<void>
}
```

### 5.2 中间件管理器

```typescript
// src/agent/middleware-manager.ts

export class MiddlewareManager {
  private middlewares: Middleware[] = []
  
  register(middleware: Middleware): void {
    this.middlewares.push(middleware)
    this.middlewares.sort((a, b) => a.priority - b.priority)
  }
  
  async executeToolCall(
    ctx: MiddlewareContext,
    handler: () => Promise<ToolResult>
  ): Promise<ToolResult> {
    const chain = this.buildChain('onToolCall', handler)
    return chain(ctx)
  }
  
  async executeModelCall(
    ctx: MiddlewareContext,
    handler: () => Promise<string>
  ): Promise<string> {
    const chain = this.buildChain('onModelCall', handler)
    return chain(ctx)
  }
  
  private buildChain(
    hook: 'onToolCall' | 'onModelCall',
    handler: () => Promise<any>
  ): (ctx: MiddlewareContext) => Promise<any> {
    const applicable = this.middlewares.filter(m => m[hook])
    
    return async (ctx: MiddlewareContext) => {
      let index = 0
      
      const next = async () => {
        if (index >= applicable.length) {
          return handler()
        }
        const middleware = applicable[index++]
        await middleware[hook]!(ctx, next)
      }
      
      return next()
    }
  }
}
```

### 5.3 内置中间件

**1. LoggingMiddleware**（优先级：10）
```typescript
export const loggingMiddleware: Middleware = {
  name: 'logging',
  priority: 10,
  
  async onToolCall(ctx, next) {
    const start = Date.now()
    console.log(`[Tool] ${ctx.toolName} started`)
    
    try {
      await next()
      console.log(`[Tool] ${ctx.toolName} completed in ${Date.now() - start}ms`)
    } catch (error) {
      console.error(`[Tool] ${ctx.toolName} failed:`, error)
      throw error
    }
  }
}
```

**2. PermissionMiddleware**（优先级：20）
```typescript
export const permissionMiddleware: Middleware = {
  name: 'permission',
  priority: 20,
  
  async onToolCall(ctx, next) {
    // 检查工具权限
    if (ctx.toolName === 'bash' && !isCommandAllowed(ctx.toolInput?.command)) {
      ctx.abort(new Error('Command not allowed'))
      return
    }
    await next()
  }
}
```

**3. CacheMiddleware**（优先级：30）
```typescript
export const cacheMiddleware: Middleware = {
  name: 'cache',
  priority: 30,
  
  async onModelCall(ctx, next) {
    // 注入缓存相关上下文
    const cacheStats = getCacheStats(ctx.sessionId)
    ctx.state.set('cacheStats', cacheStats)
    
    await next()
    
    // 记录缓存命中情况
    recordCacheHit(ctx.sessionId, ctx.modelOutput)
  }
}
```

**4. ContextInjectionMiddleware**（优先级：40）
```typescript
export const contextInjectionMiddleware: Middleware = {
  name: 'context-injection',
  priority: 40,
  
  async onModelCall(ctx, next) {
    // 注入项目上下文
    const projectContext = await getProjectContext()
    ctx.state.set('projectContext', projectContext)
    
    // 注入记忆上下文
    const memoryContext = await getMemoryContext()
    ctx.state.set('memoryContext', memoryContext)
    
    await next()
  }
}
```

### 5.4 集成点

**修改 `src/agent/loop.ts`**：
```typescript
// 在 AgentLoop 类中
private middlewareManager = new MiddlewareManager()

constructor() {
  // 注册内置中间件
  this.middlewareManager.register(loggingMiddleware)
  this.middlewareManager.register(permissionMiddleware)
  this.middlewareManager.register(cacheMiddleware)
  this.middlewareManager.register(contextInjectionMiddleware)
}

// 在工具调用处
async callTool(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
  const ctx = this.createContext({ toolName, toolInput: input })
  
  return this.middlewareManager.executeToolCall(ctx, async () => {
    // 原有的工具调用逻辑
    return this.executeTool(toolName, input)
  })
}

// 在模型调用处
async callModel(prompt: string): Promise<string> {
  const ctx = this.createContext({ modelInput: prompt })
  
  return this.middlewareManager.executeModelCall(ctx, async () => {
    // 原有的模型调用逻辑
    return this.executeModel(prompt)
  })
}
```

### 5.5 实现优先级

**Phase 1: 基础框架（2-3 天）**
- [ ] 定义 `Middleware` 接口和 `MiddlewareManager`
- [ ] 实现中间件链的构建和执行
- [ ] 提供 2-3 个内置中间件（logging, permission）
- [ ] 在 `loop.ts` 中集成中间件管理器

**Phase 2: 核心中间件（3-5 天）**
- [ ] 实现 `CacheMiddleware`：缓存统计和注入
- [ ] 实现 `ContextInjectionMiddleware`：项目和记忆上下文注入
- [ ] 实现 `ErrorHandlingMiddleware`：统一错误处理和恢复

**Phase 3: 高级特性（未来）**
- [ ] 中间件配置：通过配置文件控制中间件启用/禁用
- [ ] 中间件组合：预定义中间件组合（开发模式、生产模式）
- [ ] 中间件监控：中间件执行时间和性能统计

## 六、与 DeerFlow 的差异

| 维度 | DeerFlow | 天枢 P2 |
|------|----------|---------|
| **中间件数量** | 9 个 | 4-5 个（按需） |
| **执行模型** | LangGraph 节点 | 直接函数调用 |
| **状态管理** | ThreadState 对象 | Map<string, unknown> |
| **集成方式** | 深度集成 LangGraph | 轻量集成现有 loop |
| **复杂度** | 高（LangGraph 生态） | 低（纯 TypeScript） |

## 七、预期收益

1. **关注点分离**：横切逻辑从核心逻辑中分离，代码更清晰
2. **可测试性**：中间件可独立测试，无需启动完整 agent
3. **可扩展性**：新增横切关注点只需添加中间件，无需修改核心
4. **可观测性**：统一的日志和监控，便于调试和优化

## 八、风险和缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 性能开销 | 中 | 中 | 优化中间件链构建，缓存编译结果 |
| 调试困难 | 中 | 中 | 提供中间件执行追踪日志 |
| 状态污染 | 低 | 高 | 隔离中间件状态，防止相互影响 |
| 过度设计 | 中 | 低 | 只实现真正需要的中间件 |

---

**创建时间**：2026-06-03
**状态**：设计完成，待实现
**优先级**：P2（中）
