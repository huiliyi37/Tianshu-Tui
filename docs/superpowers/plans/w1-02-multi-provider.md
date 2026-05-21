# Wave 1 任务文档：Multi-Provider Adapter

> 任务编号：W1-02
> 优先级：高
> 预估：单 session，1.5-2 小时
> 前置依赖：无
> 后续依赖：#03 (安装体验), #13 (E2E)

## 目标

统一 Anthropic、OpenAI、DeepSeek 三家 API 为一个 provider 抽象层。用户通过配置切换 provider，天枢运行时无感知差异。

## 背景

当前天枢深度绑定 DeepSeek V4 API（`src/api/deepseek.ts` 做 usage 字段映射）。要面向所有人，必须支持主流 provider。

已有基础：
- `src/api/provider.ts` — ProviderCapabilities 抽象已存在
- `src/api/client.ts` — StreamClient 已有 retry + backoff
- `src/api/deepseek.ts` — DeepSeek 特有的 usage 映射
- `src/api/types.ts` — Message、ContentBlock、Usage 类型

## 架构设计

```
src/api/
├── types.ts              不变 — 统一的 Message/ContentBlock/Usage 类型
├── client.ts             不变 — StreamClient（provider 无关的流式处理）
├── provider.ts           扩展 — ProviderProfile 增加 adapter 工厂
├── adapters/
│   ├── deepseek.ts       从 deepseek.ts 重构 — DeepSeek V4 adapter
│   ├── anthropic.ts      新建 — Anthropic Claude adapter
│   ├── openai.ts         新建 — OpenAI GPT adapter
│   └── types.ts          新建 — ProviderAdapter interface
└── sse.ts                不变
```

### ProviderAdapter 接口

```typescript
export interface ProviderAdapter {
  /** 将统一 MessageRequest 转换为 provider 特定的 HTTP 请求 */
  buildHttpRequest(request: MessageRequest): { url: string; headers: Record<string, string>; body: unknown }
  
  /** 将 provider 特定的 SSE chunk 转换为统一的 StreamEvent */
  parseStreamChunk(chunk: unknown): StreamEvent | null
  
  /** 将 provider 特定的 usage 字段映射为统一 Usage */
  mapUsage(raw: unknown): Usage
  
  /** provider 特定的 prefix cache 行为 */
  cacheStrategy: 'deepseek-prefix' | 'anthropic-cache-control' | 'none'
}
```

### 配置

```typescript
// src/config/schema.ts 扩展
provider: z.enum(['deepseek', 'anthropic', 'openai']).default('deepseek')
apiKey: z.string()  // 或从环境变量读取
model: z.string().optional()  // 覆盖默认模型
baseUrl: z.string().optional()  // 自定义 endpoint
```

环境变量优先级：
- `TIANSHU_PROVIDER` > config file > default ('deepseek')
- `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`

## 实现计划

### Task 1: ProviderAdapter 接口定义

创建 `src/api/adapters/types.ts`：
- ProviderAdapter interface
- ProviderName type
- createAdapter 工厂函数签名

### Task 2: DeepSeek adapter 重构

将 `src/api/deepseek.ts` 的逻辑迁移到 `src/api/adapters/deepseek.ts`：
- buildHttpRequest — DeepSeek V4 的 endpoint + headers
- parseStreamChunk — 现有的 SSE 解析
- mapUsage — 现有的 usage 字段映射（cache_read_input_tokens 等）
- cacheStrategy: 'deepseek-prefix'

保持 `src/api/deepseek.ts` 作为 re-export（不破坏现有 import）。

### Task 3: Anthropic adapter

创建 `src/api/adapters/anthropic.ts`：
- buildHttpRequest — `https://api.anthropic.com/v1/messages`
- parseStreamChunk — Anthropic 的 `message_start` / `content_block_delta` / `message_delta` 事件格式
- mapUsage — `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`
- cacheStrategy: 'anthropic-cache-control'

### Task 4: OpenAI adapter

创建 `src/api/adapters/openai.ts`：
- buildHttpRequest — `https://api.openai.com/v1/chat/completions`
- parseStreamChunk — OpenAI 的 `choices[0].delta` 格式
- mapUsage — `prompt_tokens` / `completion_tokens`（无 cache 字段）
- cacheStrategy: 'none'

### Task 5: StreamClient 集成

修改 `src/api/client.ts`：
- 构造函数接受 `ProviderAdapter`
- `stream()` 方法使用 adapter.buildHttpRequest 构建请求
- SSE 解析使用 adapter.parseStreamChunk
- Usage 汇总使用 adapter.mapUsage

### Task 6: 配置集成

修改 `src/config/schema.ts`：
- 新增 provider / apiKey / model / baseUrl 字段

修改 `src/main.tsx`：
- 根据配置创建对应 adapter
- 传入 StreamClient

### Task 7: 测试

- `src/api/adapters/__tests__/deepseek.test.ts` — 现有行为不变
- `src/api/adapters/__tests__/anthropic.test.ts` — mock SSE 解析
- `src/api/adapters/__tests__/openai.test.ts` — mock SSE 解析
- `src/api/__tests__/client-adapter.test.ts` — adapter 切换集成测试

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/api/adapters/__tests__/*.test.ts
npx tsx --test src/api/__tests__/client-adapter.test.ts
```

## 注意事项

- Anthropic 的 tool_use 格式与 DeepSeek/OpenAI 不同（content block vs function_call）— adapter 需要做双向转换
- OpenAI 的 function_calling 格式需要映射到统一的 tool_use ContentBlock
- Prefix cache 行为差异大：DeepSeek 自动 prefix match，Anthropic 需要 cache_control 标记，OpenAI 无 cache
- 不要在 adapter 中做业务逻辑（compaction、CVM 等）— adapter 只负责协议转换

## 不做的事

- 不做模型路由（根据任务自动选模型）— 后续迭代
- 不做多 provider 同时在线 — 一次只用一个 provider
- 不做 provider 健康检查 — 后续迭代
- 不做本地模型支持（Ollama 等）— 后续迭代
