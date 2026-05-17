# Multi-Provider Adapter Design

## 背景

Rivet 需要接入多个模型 provider：
- **Codex (GPT-5.5)**: 主控 agent，OAuth PKCE 认证，验证 GPT-5.5 在 TUI 的表现
- **MiniMax (M2.7)**: 子代理廉价 worker，API key 认证
- **MiMo (V2.5/V2.5-Pro)**: 子代理备用，API key 认证
- **OpenCode Go**: 聚合入口，API key 认证

核心约束：子代理和主控使用不同 provider（如 MiniMax 做廉价消耗，GPT-5.5 做主控）。

## 调研发现

### 已验证的事实
- MiniMax、MiMo 已双协议兼容（OpenAI + Anthropic），API key 认证
- Codex OAuth 使用 PKCE 流程 + 设备流（无头环境），token 存 `~/.codex/auth.json`
- hermes-agent 的插件注册表模式（15+ provider）对 Rivet 当前规模（5-8 provider）是过度工程
- Rivet 的 `WorkerSessionConfig.client: StreamClient` 已支持 per-worker 独立 client

### 关键架构洞察
- **认证和协议是两个正交维度**：MiniMax 用 OpenAI 协议 + API key，Codex 用 OpenAI 协议 + OAuth
- **现有双协议已覆盖所有目标 provider 的传输层**，瓶颈在认证而非协议
- **子代理路由已有基础**：`ModelCapabilityCard` + `recommendModelForTask()` + `WorkerRuntimeFactory`

## 架构设计

### 认证分离层（src/auth/）

```
src/auth/
├── types.ts           # AuthProvider 接口
├── api-key.ts         # API key 认证（从 factory.ts 抽取）
├── oauth.ts           # OAuth 2.0 PKCE 流程
├── device-flow.ts     # 设备流（无头/SSH 环境）
├── token-store.ts     # ~/.rivet/auth/{provider}.json 统一存储
├── refresh.ts         # Token 自动刷新（55min 策略）
└── __tests__/
```

核心接口：

```typescript
interface AuthProvider {
  /** 返回认证所需的 HTTP headers */
  getHeaders(): Promise<Record<string, string>>
  /** 当前是否已认证 */
  isAuthenticated(): boolean
  /** 触发认证流程（OAuth 浏览器跳转 / 提示输入 key） */
  authenticate(): Promise<void>
  /** 清理资源 */
  dispose(): void
}
```

### Config Schema 扩展

```typescript
// providerSchema 新增 auth 字段
auth: z.discriminatedUnion('type', [
  z.object({
    type: z.literal('api-key'),
    keyEnv: z.string(),           // 环境变量名
  }),
  z.object({
    type: z.literal('oauth'),
    provider: z.enum(['codex']),  // OAuth provider 类型
  }),
]).default({ type: 'api-key', keyEnv: 'API_KEY' })

// 新增 workers 配置
const workerProfileSchema = z.object({
  provider: z.string(),           // provider 名称
  model: z.string(),              // model ID
})

const routingSchema = z.record(
  z.enum(['code_edit', 'repo_summarization', 'test_failure_diagnosis', 'compaction', 'risky_refactor']),
  z.string(),                     // worker profile 名称
)

const workersSchema = z.object({
  profiles: z.record(workerProfileSchema),  // cheap, capable, etc.
  routing: routingSchema.default({
    code_edit: 'capable',
    repo_summarization: 'cheap',
    test_failure_diagnosis: 'cheap',
    compaction: 'cheap',
    risky_refactor: 'capable',
  }),
})
```

### Worker 路由

```
config.yaml 示例:

providers:
  - name: codex
    baseUrl: https://api.openai.com/v1
    protocol: openai
    auth:
      type: oauth
      provider: codex
    models:
      - id: gpt-5.5
        contextWindow: 1000000
        maxTokens: 64000

  - name: minimax
    baseUrl: https://api.minimax.io/v1
    protocol: openai
    auth:
      type: api-key
      keyEnv: MINIMAX_API_KEY
    models:
      - id: MiniMax-M2.7
        contextWindow: 204800
        maxTokens: 64000

workers:
  profiles:
    capable:
      provider: codex
      model: gpt-5.5
    cheap:
      provider: minimax
      model: MiniMax-M2.7
  routing:
    code_edit: capable
    repo_summarization: cheap
    test_failure_diagnosis: cheap
    compaction: cheap
    risky_refactor: capable
```

## 实施路径

### Phase 1: Codex OAuth（P0，~3 天）

**目标**: 让 Rivet 能通过 ChatGPT Pro 订阅调用 GPT-5.5

**改动范围**:
1. `src/auth/types.ts` — AuthProvider 接口
2. `src/auth/api-key.ts` — 从 factory.ts 抽取现有 API key 逻辑
3. `src/auth/oauth.ts` — OAuth 2.0 PKCE 流程
4. `src/auth/device-flow.ts` — 设备流（无头环境）
5. `src/auth/token-store.ts` — `~/.rivet/auth/codex.json` 存储
6. `src/auth/refresh.ts` — 55 分钟自动刷新
7. `src/api/factory.ts` — 注入 AuthProvider
8. `src/config/schema.ts` — auth 字段扩展
9. 测试: `src/auth/__tests__/*.test.ts`

**成功标准**:
- `rivet --provider codex --model gpt-5.5` 能通过 OAuth 完成认证
- Token 自动刷新（55min），不丢失会话
- 设备流在 SSH 环境下可用

**退出条件**: 如果 OpenAI 更改 OAuth 端点导致 PKCE 流程失败，降级为 API key 模式

### Phase 2: MiniMax/MiMo API key 接入（P1，~1 天）

**目标**: 子代理可用廉价模型

**改动范围**:
1. `src/api/provider.ts` — WELL_KNOWN_DEFAULTS 加 minimax、mimo 条目
2. `src/api/provider-profile.ts` — PROFILES 加缓存策略
3. `src/auth/types.ts` — 让 auth 层支持新 provider
4. 测试: provider-profile 测试扩展

**成功标准**:
- config.yaml 配置 minimax provider 后，`/model minimax/MiniMax-M2.7` 可用
- MiMo 的 thinking mode 正常工作

### Phase 3: Worker 路由配置（P2，~2 天）

**目标**: 子代理按任务类型自动选择 provider

**改动范围**:
1. `src/config/schema.ts` — workers + routing schema
2. `src/agent/coordinator.ts` — 读取 routing config，按 task type 选 worker profile
3. `src/agent/worker-session.ts` — 从 worker profile 创建独立 StreamClient
4. `src/agent/coordinator-state.ts` — 路由状态追踪
5. 测试: coordinator + worker-session 测试扩展

**成功标准**:
- 子代理 code_edit 任务用 GPT-5.5，compaction 任务用 MiniMax
- 路由可通过 config.yaml 声明式配置
- `/model` 命令可覆盖默认路由

### Phase 4: OpenCode Go（P3，~0.5 天）

**改动**: WELL_KNOWN_DEFAULTS 加 opencode-go 条目 + config 示例

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Codex OAuth 端点变更 | P0 阻塞 | 降级为 API key 模式 |
| MiniMax interleaved thinking 破坏历史消息 | compaction 丢推理 | 在 compaction 时保留 reasoning_details |
| MiMo reasoning_content 字段格式差异 | OpenAIClient 解析失败 | OpenAIClient 加 provider-specific 解析分支 |
| 子代理用廉价模型质量不够 | 任务失败率上升 | routing 配置可随时调整 + 自动重试 |

## 扩展适应

- 现有 `ProviderCapabilities` + `WELL_KNOWN_DEFAULTS` → 直接扩展，零破坏
- 现有 `providerSchema.protocol` 字段 → 扩展 auth 字段，正交设计
- 现有 `ModelCapabilityCard` + `recommendModelForTask()` → 可在 Phase 3 后增强为 cost-aware 路由
- 现有 `WorkerRuntimeFactory` → 改为从 routing config 读取 provider，不改接口
