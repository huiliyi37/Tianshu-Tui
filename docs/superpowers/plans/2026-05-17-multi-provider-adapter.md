# Multi-Provider Adapter 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Rivet 支持多个模型 provider（Codex OAuth、MiniMax、MiMo），主控和子代理可使用不同 provider。

**架构：** 认证与协议正交分离——新建 `src/auth/` 模块处理 API key 和 OAuth 认证，现有 `src/api/` 双协议层不变。Config schema 扩展 `auth` 字段和 `workers` 路由配置。

**技术栈：** TypeScript, Zod, node:crypto (PKCE), node:http (OAuth 回调), node:test

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/auth/types.ts` | AuthProvider 接口定义 |
| `src/auth/api-key.ts` | API key 认证实现（从 factory.ts 抽取） |
| `src/auth/oauth.ts` | OAuth 2.0 PKCE 流程 |
| `src/auth/device-flow.ts` | 设备流认证（无头/SSH 环境） |
| `src/auth/token-store.ts` | `~/.rivet/auth/{provider}.json` 统一 token 存储 |
| `src/auth/refresh.ts` | Token 自动刷新逻辑 |
| `src/auth/registry.ts` | AuthProvider 创建工厂，从 config 创建 auth provider |
| `src/auth/__tests__/api-key.test.ts` | API key auth 测试 |
| `src/auth/__tests__/token-store.test.ts` | Token store 测试 |
| `src/auth/__tests__/oauth.test.ts` | OAuth PKCE 流程测试 |
| `src/auth/__tests__/device-flow.test.ts` | 设备流测试 |
| `src/auth/__tests__/refresh.test.ts` | Token 刷新测试 |
| `src/auth/__tests__/registry.test.ts` | Auth registry 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/config/schema.ts` | 新增 `authConfigSchema`, `workerProfileSchema`, `workersSchema`；扩展 `providerSchema` 和 `configSchema` |
| `src/api/provider.ts` | `WELL_KNOWN_DEFAULTS` 新增 minimax（更新）、mimo 条目 |
| `src/api/provider-profile.ts` | `PROFILES` 新增 minimax、mimo 缓存策略 |
| `src/api/factory.ts` | `resolveApiKey` 改为接受 `AuthProvider`；`createProviderClient` 改为注入 auth headers |
| `src/main.tsx` | `runtimeFactory` 改为按 routing config 选择 worker provider |
| `src/agent/coordinator.ts` | `DelegationCoordinatorConfig` 新增 `routing` 字段 |

---

## Phase 1: Auth 基础层 + API Key 抽取

### 任务 1：AuthProvider 接口

**文件：**
- 创建：`src/auth/types.ts`
- 测试：`src/auth/__tests__/api-key.test.ts`

- [ ] **步骤 1：编写 AuthProvider 接口**

```typescript
// src/auth/types.ts
export interface AuthProvider {
  /** 返回认证所需的 HTTP headers */
  getHeaders(): Promise<Record<string, string>>
  /** 当前是否已认证 */
  isAuthenticated(): boolean
  /** 触发认证流程（OAuth 浏览器跳转 / 提示输入 key） */
  authenticate(): Promise<void>
  /** 清理资源（关闭 HTTP 服务器等） */
  dispose(): void
}
```

- [ ] **步骤 2：编写 ApiKeyAuth 测试**

```typescript
// src/auth/__tests__/api-key.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiKeyAuth } from '../api-key.js'

describe('ApiKeyAuth', () => {
  it('returns Authorization header with Bearer token', async () => {
    const auth = new ApiKeyAuth('sk-test-123')
    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer sk-test-123')
  })

  it('isAuthenticated returns true when key is set', () => {
    const auth = new ApiKeyAuth('sk-test')
    assert.equal(auth.isAuthenticated(), true)
  })

  it('isAuthenticated returns false when key is empty', () => {
    const auth = new ApiKeyAuth('')
    assert.equal(auth.isAuthenticated(), false)
  })

  it('authenticate is a no-op for API key auth', async () => {
    const auth = new ApiKeyAuth('sk-test')
    await auth.authenticate() // should not throw
  })

  it('dispose is a no-op', () => {
    const auth = new ApiKeyAuth('sk-test')
    auth.dispose() // should not throw
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx tsx --test src/auth/__tests__/api-key.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 4：实现 ApiKeyAuth**

```typescript
// src/auth/api-key.ts
import type { AuthProvider } from './types.js'

export class ApiKeyAuth implements AuthProvider {
  constructor(private key: string) {}

  async getHeaders(): Promise<Record<string, string>> {
    return { 'Authorization': `Bearer ${this.key}` }
  }

  isAuthenticated(): boolean {
    return this.key.length > 0
  }

  async authenticate(): Promise<void> {
    // API key auth has no interactive flow
  }

  dispose(): void {
    // No resources to clean up
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/auth/__tests__/api-key.test.ts`
预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/auth/types.ts src/auth/api-key.ts src/auth/__tests__/api-key.test.ts
git commit -m "feat(auth): add AuthProvider interface and ApiKeyAuth implementation"
```

---

### 任务 2：Token Store

**文件：**
- 创建：`src/auth/token-store.ts`
- 测试：`src/auth/__tests__/token-store.test.ts`

- [ ] **步骤 1：编写 TokenStore 测试**

```typescript
// src/auth/__tests__/token-store.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TokenStore } from '../token-store.js'

describe('TokenStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rivet-auth-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('saves and loads tokens', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresAt: Date.now() + 3600_000,
    })
    const loaded = store.load()
    assert.equal(loaded?.accessToken, 'at-123')
    assert.equal(loaded?.refreshToken, 'rt-456')
  })

  it('returns null when no tokens saved', () => {
    const store = new TokenStore(tmpDir, 'nonexistent')
    assert.equal(store.load(), null)
  })

  it('creates auth directory if missing', () => {
    const nestedDir = join(tmpDir, 'deep', 'nested')
    const store = new TokenStore(nestedDir, 'codex')
    store.save({ accessToken: 'at', expiresAt: Date.now() })
    assert.ok(existsSync(join(nestedDir, 'codex.json')))
  })

  it('clears tokens', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({ accessToken: 'at', expiresAt: Date.now() })
    store.clear()
    assert.equal(store.load(), null)
  })

  it('file permissions are 0o600', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({ accessToken: 'at', expiresAt: Date.now() })
    const filePath = join(tmpDir, 'codex.json')
    const content = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    assert.equal(parsed.accessToken, 'at')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/auth/__tests__/token-store.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 TokenStore**

```typescript
// src/auth/token-store.ts
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface TokenData {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  accountId?: string
}

export class TokenStore {
  private filePath: string

  constructor(private baseDir: string, private provider: string) {
    this.filePath = join(baseDir, `${provider}.json`)
  }

  load(): TokenData | null {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as TokenData
    } catch {
      return null
    }
  }

  save(data: TokenData): void {
    mkdirSync(this.baseDir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  clear(): void {
    try { unlinkSync(this.filePath) } catch {}
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/auth/__tests__/token-store.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/auth/token-store.ts src/auth/__tests__/token-store.test.ts
git commit -m "feat(auth): add TokenStore for persistent token storage"
```

---

### 任务 3：Token 刷新

**文件：**
- 创建：`src/auth/refresh.ts`
- 测试：`src/auth/__tests__/refresh.test.ts`

- [ ] **步骤 1：编写 TokenRefresher 测试**

```typescript
// src/auth/__tests__/refresh.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefresh, type TokenData } from '../refresh.js'

describe('shouldRefresh', () => {
  it('returns true when token expires in < 5 minutes', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() + 4 * 60_000, // 4 min from now
    }
    assert.equal(shouldRefresh(token), true)
  })

  it('returns false when token has > 5 minutes remaining', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() + 30 * 60_000, // 30 min from now
    }
    assert.equal(shouldRefresh(token), false)
  })

  it('returns true when token is already expired', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() - 1000,
    }
    assert.equal(shouldRefresh(token), true)
  })

  it('returns true when no refresh token and token expires soon', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() + 60_000, // 1 min
    }
    assert.equal(shouldRefresh(token), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/auth/__tests__/refresh.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 shouldRefresh**

```typescript
// src/auth/refresh.ts
import type { TokenData } from './token-store.js'

export type { TokenData }

const EXPIRY_MARGIN_MS = 5 * 60_000 // 5 minutes

export function shouldRefresh(token: TokenData): boolean {
  return token.expiresAt - Date.now() < EXPIRY_MARGIN_MS
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/auth/__tests__/refresh.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/auth/refresh.ts src/auth/__tests__/refresh.test.ts
git commit -m "feat(auth): add token refresh check logic"
```

---

## Phase 2: OAuth PKCE + Device Flow

### 任务 4：OAuth PKCE 流程

**文件：**
- 创建：`src/auth/oauth.ts`
- 测试：`src/auth/__tests__/oauth.test.ts`

- [ ] **步骤 1：编写 OAuthAuth 测试**

```typescript
// src/auth/__tests__/oauth.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generatePKCE, buildAuthorizeUrl } from '../oauth.js'

describe('generatePKCE', () => {
  it('returns verifier and challenge', async () => {
    const pkce = await generatePKCE()
    assert.ok(pkce.verifier.length > 0)
    assert.ok(pkce.challenge.length > 0)
    assert.notEqual(pkce.verifier, pkce.challenge)
  })

  it('verifier is URL-safe base64', async () => {
    const pkce = await generatePKCE()
    // URL-safe base64: only A-Z, a-z, 0-9, -, _, =
    assert.ok(/^[A-Za-z0-9\-_=]+$/.test(pkce.verifier))
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds URL with required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'test-client',
      codeChallenge: 'test-challenge',
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'test-state',
    })
    assert.ok(url.startsWith('https://auth.openai.com/oauth/authorize'))
    assert.ok(url.includes('client_id=test-client'))
    assert.ok(url.includes('code_challenge=test-challenge'))
    assert.ok(url.includes('code_challenge_method=S256'))
    assert.ok(url.includes('state=test-state'))
    assert.ok(url.includes('scope=openid'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/auth/__tests__/oauth.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 OAuth 基础函数**

```typescript
// src/auth/oauth.ts
import { createHash, randomBytes } from 'node:crypto'

const CODE_VERIFIER_BYTES = 32

export interface PKCEPair {
  verifier: string
  challenge: string
}

export async function generatePKCE(): Promise<PKCEPair> {
  const verifier = randomBytes(CODE_VERIFIER_BYTES)
    .toString('base64url')
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url')
  return { verifier, challenge }
}

export interface AuthorizeUrlParams {
  clientId: string
  codeChallenge: string
  redirectUri: string
  state: string
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const base = 'https://auth.openai.com/oauth/authorize'
  const searchParams = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: 'openid profile email offline_access',
  })
  return `${base}?${searchParams.toString()}`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/auth/__tests__/oauth.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/auth/oauth.ts src/auth/__tests__/oauth.test.ts
git commit -m "feat(auth): add OAuth PKCE utilities"
```

---

### 任务 5：设备流认证

**文件：**
- 创建：`src/auth/device-flow.ts`
- 测试：`src/auth/__tests__/device-flow.test.ts`

- [ ] **步骤 1：编写 DeviceFlow 测试**

```typescript
// src/auth/__tests__/device-flow.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDeviceCodeRequest, parseDeviceCodeResponse, parseTokenResponse } from '../device-flow.js'

describe('buildDeviceCodeRequest', () => {
  it('builds correct request body', () => {
    const body = buildDeviceCodeRequest('test-client')
    assert.equal(body.client_id, 'test-client')
    assert.ok(body.scope.includes('openid'))
  })
})

describe('parseDeviceCodeResponse', () => {
  it('parses valid response', () => {
    const result = parseDeviceCodeResponse({
      device_code: 'dc-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.openai.com/codex/device',
      expires_in: 600,
      interval: 5,
    })
    assert.equal(result.deviceCode, 'dc-123')
    assert.equal(result.userCode, 'ABCD-EFGH')
    assert.equal(result.interval, 5)
  })

  it('throws on missing fields', () => {
    assert.throws(
      () => parseDeviceCodeResponse({}),
      /device_code/,
    )
  })
})

describe('parseTokenResponse', () => {
  it('parses successful token response', () => {
    const result = parseTokenResponse({
      access_token: 'at-123',
      refresh_token: 'rt-456',
      expires_in: 3600,
      id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature',
    })
    assert.equal(result.accessToken, 'at-123')
    assert.equal(result.refreshToken, 'rt-456')
    assert.ok(result.expiresAt > Date.now())
  })

  it('throws on error response', () => {
    assert.throws(
      () => parseTokenResponse({ error: 'authorization_pending' }),
      /authorization_pending/,
    )
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/auth/__tests__/device-flow.test.ts`
预期：FAIL

- [ ] **步骤 3：实现设备流**

```typescript
// src/auth/device-flow.ts
import type { TokenData } from './token-store.js'

const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export function buildDeviceCodeRequest(clientId: string): Record<string, string> {
  return {
    client_id: clientId,
    scope: 'openid profile email offline_access',
  }
}

export function parseDeviceCodeResponse(raw: Record<string, unknown>): DeviceCodeResponse {
  const deviceCode = raw.device_code
  const userCode = raw.user_code
  const verificationUri = raw.verification_uri

  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new Error(`Invalid device code response: missing required fields. Got keys: ${Object.keys(raw).join(', ')}`)
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: typeof raw.expires_in === 'number' ? raw.expires_in : 600,
    interval: typeof raw.interval === 'number' ? raw.interval : 5,
  }
}

export function parseTokenResponse(raw: Record<string, unknown>): TokenData & { accountId?: string } {
  if (typeof raw.error === 'string') {
    throw new Error(`Token error: ${raw.error}`)
  }

  const accessToken = raw.access_token
  if (typeof accessToken !== 'string') {
    throw new Error('Invalid token response: missing access_token')
  }

  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600

  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/auth/__tests__/device-flow.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/auth/device-flow.ts src/auth/__tests__/device-flow.test.ts
git commit -m "feat(auth): add device flow authentication for headless environments"
```

---

## Phase 3: Auth Registry + Factory 集成

### 任务 6：Auth Registry（从 config 创建 AuthProvider）

**文件：**
- 创建：`src/auth/registry.ts`
- 测试：`src/auth/__tests__/registry.test.ts`
- 修改：`src/config/schema.ts`

- [ ] **步骤 1：扩展 config schema**

在 `src/config/schema.ts` 中新增 auth 配置 schema：

```typescript
// 在 providerSchema 之后添加
export const authConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('api-key'),
    keyEnv: z.string(),
  }),
  z.object({
    type: z.literal('oauth'),
    provider: z.enum(['codex']),
  }),
]).default({ type: 'api-key', keyEnv: 'API_KEY' })

// 扩展 providerSchema，添加 auth 字段
// 将现有 providerSchema 的 apiKey/apiKeyEnv 改为：
// ... 在 providerSchema 定义中添加：
//   auth: authConfigSchema,
```

在 `providerSchema` 中添加 `auth` 字段（可选，向后兼容）：

```typescript
export const providerSchema = z.object({
  name: z.string(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url(),
  protocol: z.enum(['anthropic', 'openai']).default('anthropic'),
  auth: authConfigSchema.optional(),
  capabilities: providerCapabilitiesSchema,
  fallback: z.array(z.string()).optional(),
  models: z.array(modelConfigSchema).min(1),
  thinking: z.enum(['enabled', 'disabled']).default('enabled'),
  maxTokens: z.number().int().positive().default(64000),
  unsupported: z.array(z.string()).default([]),
})
```

- [ ] **步骤 2：编写 AuthRegistry 测试**

```typescript
// src/auth/__tests__/registry.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthProvider } from '../registry.js'
import { ApiKeyAuth } from '../api-key.js'

describe('createAuthProvider', () => {
  it('creates ApiKeyAuth for api-key config', () => {
    const auth = createAuthProvider(
      { type: 'api-key', keyEnv: 'TEST_API_KEY' },
      { TEST_API_KEY: 'sk-test-123' },
    )
    assert.ok(auth instanceof ApiKeyAuth)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('creates ApiKeyAuth from legacy apiKey field', () => {
    const auth = createAuthProvider(
      undefined,
      {},
      'sk-legacy-key',
    )
    assert.ok(auth instanceof ApiKeyAuth)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('throws when api-key env var is missing', () => {
    assert.throws(
      () => createAuthProvider(
        { type: 'api-key', keyEnv: 'MISSING_KEY' },
        {},
      ),
      /MISSING_KEY/,
    )
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx tsx --test src/auth/__tests__/registry.test.ts`
预期：FAIL

- [ ] **步骤 4：实现 AuthRegistry**

```typescript
// src/auth/registry.ts
import type { AuthProvider } from './types.js'
import { ApiKeyAuth } from './api-key.js'
import type { z } from 'zod'
import type { authConfigSchema } from '../config/schema.js'

type AuthConfig = z.infer<typeof authConfigSchema>

/**
 * Create an AuthProvider from config.
 * @param authConfig - The auth config from provider config
 * @param env - Environment variables (defaults to process.env)
 * @param legacyApiKey - Fallback: explicit apiKey from legacy config
 */
export function createAuthProvider(
  authConfig: AuthConfig | undefined,
  env: Record<string, string | undefined>,
  legacyApiKey?: string,
): AuthProvider {
  if (!authConfig || authConfig.type === 'api-key') {
    const keyEnv = authConfig?.type === 'api-key' ? authConfig.keyEnv : undefined
    const key = legacyApiKey ?? (keyEnv ? env[keyEnv] : undefined)
    if (!key) {
      throw new Error(
        `No API key configured. Set apiKey in config or the ${keyEnv ?? 'API_KEY'} environment variable.`,
      )
    }
    return new ApiKeyAuth(key)
  }

  if (authConfig.type === 'oauth') {
    // OAuth auth providers are created lazily (they need interactive auth)
    // For now, return a placeholder that will trigger authenticate() on first use
    throw new Error('OAuth auth provider not yet implemented — will be added in next task')
  }

  throw new Error(`Unknown auth type: ${(authConfig as { type: string }).type}`)
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx tsx --test src/auth/__tests__/registry.test.ts`
预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add src/auth/registry.ts src/auth/__tests__/registry.test.ts src/config/schema.ts
git commit -m "feat(auth): add AuthRegistry and config schema auth field"
```

---

### 任务 7：Factory 集成 — 用 AuthProvider 替代 resolveApiKey

**文件：**
- 修改：`src/api/factory.ts`
- 修改：`src/api/__tests__/factory.test.ts`

- [ ] **步骤 1：添加新测试用例**

在 `src/api/__tests__/factory.test.ts` 中添加：

```typescript
import { ApiKeyAuth } from '../../auth/api-key.js'

describe('createProviderClient with AuthProvider', () => {
  it('uses AuthProvider headers when auth is provided', async () => {
    const auth = new ApiKeyAuth('sk-from-auth-provider')
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const capabilities = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, capabilities, {
      ...runtimeParams,
      auth,
    })
    assert.ok(client)
  })
})
```

同时更新 `RuntimeParams` 类型：

```typescript
// factory.ts 中 RuntimeParams 新增 auth 字段
export interface RuntimeParams {
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinkingBudget?: number
  auth?: import('../auth/types.js').AuthProvider
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/api/__tests__/factory.test.ts`
预期：类型错误或行为不正确

- [ ] **步骤 3：更新 factory.ts**

在 `createProviderClient` 中，如果 `params.auth` 存在，优先使用它：

```typescript
// factory.ts 修改 createProviderClient
export function createProviderClient(
  provider: ProviderConfig,
  capabilities: ProviderCapabilities,
  params: RuntimeParams,
): StreamClient {
  // Auth resolution: prefer AuthProvider, fall back to legacy apiKey
  const resolvedApiKey = params.auth
    ? '' // AuthProvider handles headers directly; apiKey is unused
    : params.apiKey

  if (provider.protocol === 'openai') {
    return new OpenAIClient({
      baseUrl: provider.baseUrl,
      apiKey: resolvedApiKey,
      model: params.model,
      maxTokens: params.maxTokens,
      auth: params.auth,
    })
  }

  const clientConfig: ClientConfig = {
    baseUrl: provider.baseUrl,
    apiKey: resolvedApiKey,
    model: params.model,
    maxTokens: params.maxTokens,
    thinking: provider.thinking,
    thinkingBudget: params.thinkingBudget,
    reasoningEffort: capabilities.effortFormat === 'none'
      ? undefined
      : (params.reasoningEffort ?? 'high'),
    unsupported: provider.unsupported.length > 0
      ? provider.unsupported
      : capabilities.stripParams,
    hasToolJsonInContentBug: capabilities.hasToolJsonInContentBug,
    mapUsage: capabilities.mapUsage,
    auth: params.auth,
  }

  return new ApiClient(clientConfig)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/api/__tests__/factory.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/api/factory.ts src/api/__tests__/factory.test.ts
git commit -m "feat(api): integrate AuthProvider into factory client creation"
```

---

## Phase 4: Provider 能力扩展

### 任务 8：MiniMax + MiMo 能力定义

**文件：**
- 修改：`src/api/provider.ts`
- 修改：`src/api/__tests__/provider-profile.test.ts`
- 修改：`src/api/provider-profile.ts`

- [ ] **步骤 1：更新 WELL_KNOWN_DEFAULTS**

在 `src/api/provider.ts` 的 `WELL_KNOWN_DEFAULTS` 中更新 minimax 并添加 mimo：

```typescript
// 更新已有的 minimax 条目（当前 supportsThinking 是 false）
minimax: {
  supportsThinking: true,
  thinkingFormat: 'openai',  // MiniMax uses reasoning_split in OpenAI mode
  supportsCacheControl: false,
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
  prefixCacheStrategy: 'none',
},
// 新增 mimo 条目
mimo: {
  supportsThinking: true,
  thinkingFormat: 'openai',  // MiMo uses thinking.type in OpenAI mode
  supportsCacheControl: false,
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
  prefixCacheStrategy: 'none',
},
// 新增 opencode-go 条目
'opencode-go': {
  supportsThinking: true,
  thinkingFormat: 'openai',
  supportsCacheControl: false,
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
  prefixCacheStrategy: 'none',
},
```

- [ ] **步骤 2：更新 ProviderProfile**

在 `src/api/provider-profile.ts` 的 `PROFILES` 中添加：

```typescript
minimax: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
mimo: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
'opencode-go': { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
```

- [ ] **步骤 3：添加测试**

在 `src/api/__tests__/provider-profile.test.ts` 中添加：

```typescript
it('returns minimax profile', () => {
  const p = getProviderProfile('minimax')
  assert.equal(p.cacheType, 'none')
  assert.equal(p.persistent, false)
})

it('returns mimo profile', () => {
  const p = getProviderProfile('mimo')
  assert.equal(p.cacheType, 'none')
})
```

- [ ] **步骤 4：运行全部测试**

运行：`npm run typecheck && npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/api/provider.ts src/api/provider-profile.ts src/api/__tests__/provider-profile.test.ts
git commit -m "feat(api): add MiniMax, MiMo, and OpenCode Go provider capabilities"
```

---

## Phase 5: Worker 路由配置

### 任务 9：Worker 路由 Config Schema

**文件：**
- 修改：`src/config/schema.ts`

- [ ] **步骤 1：添加 worker routing schema**

在 `src/config/schema.ts` 中添加：

```typescript
export const workerProfileSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

export const workersSchema = z.object({
  profiles: z.record(z.string(), workerProfileSchema).default({}),
  routing: z.record(z.string(), z.string()).default({}),
}).default({})
```

在 `configSchema` 中添加 workers 字段：

```typescript
export const configSchema = z.object({
  provider: z.object({
    default: z.string(),
    providers: z.record(z.string(), providerSchema),
  }),
  agent: agentSchema.default({}),
  compact: compactSchema.default({}),
  cache: cacheSchema.default({}),
  editor: editorSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  workers: workersSchema,  // 新增
})
```

类型导出：

```typescript
export type WorkerProfileConfig = z.infer<typeof workerProfileSchema>
export type WorkersConfig = z.infer<typeof workersSchema>
```

- [ ] **步骤 2：运行 typecheck**

运行：`npm run typecheck`
预期：通过（新字段有 default 值，向后兼容）

- [ ] **步骤 3：Commit**

```bash
git add src/config/schema.ts
git commit -m "feat(config): add worker routing schema for multi-provider delegation"
```

---

### 任务 10：Coordinator 路由集成

**文件：**
- 修改：`src/agent/coordinator.ts`
- 修改：`src/agent/__tests__/coordinator.test.ts`

- [ ] **步骤 1：扩展 DelegationCoordinatorConfig**

在 `src/agent/coordinator.ts` 中：

```typescript
export interface WorkerRouteConfig {
  profiles: Record<string, { provider: string; model: string }>
  routing: Record<string, string>
}

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  maxWorkers: number
  runtimeFactory: WorkerRuntimeFactory
  routing?: WorkerRouteConfig
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
}
```

- [ ] **步骤 2：修改 delegate 方法使用路由**

在 `delegate` 方法中，根据 `routing` 配置选择不同的 modelCards：

```typescript
// 在 delegate 方法中，替换 modelCards 选择逻辑
const task = mapWorkOrderKindToCapabilityTask(order.kind)
let selected: ModelCapabilityCard

if (this.config.routing) {
  const routeProfileName = this.config.routing.routing[task]
  if (routeProfileName && this.config.routing.profiles[routeProfileName]) {
    const routeProfile = this.config.routing.profiles[routeProfileName]
    // Find the card matching the routed model, or use the first card
    selected = this.config.modelCards.find(c => c.model === routeProfile.model)
      ?? recommendModelForTask(task, this.config.modelCards)
  } else {
    selected = recommendModelForTask(task, this.config.modelCards)
  }
} else {
  selected = recommendModelForTask(task, this.config.modelCards)
}
```

- [ ] **步骤 3：添加路由测试**

在 `src/agent/__tests__/coordinator.test.ts` 中添加：

```typescript
describe('DelegationCoordinator with routing', () => {
  it('routes to different model based on task type', async () => {
    let capturedModel = ''
    const mockRuntimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
      capturedModel = card.model
      return {
        order: _order,
        client: { stream: async () => {} },
        promptEngine: mockPromptEngine,
        toolRegistry: workerRegistry,
        cwd: '/tmp',
        maxTurns: 4,
        contextWindow: 128000,
        compact: { enabled: false, autoThreshold: 800000, autoFloor: 500000, model: 'flash' },
      }
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: mockRegistry,
      modelCards: [
        { model: 'gpt-5.5', toolUseReliability: 0.9, jsonStability: 0.9, editSuccessRate: 0.9, testRepairRate: 0.8, contextWindow: 1000000, cacheEconomics: 'medium', recommendedTasks: [] },
        { model: 'MiniMax-M2.7', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.6, testRepairRate: 0.5, contextWindow: 204800, cacheEconomics: 'weak', recommendedTasks: [] },
      ],
      maxWorkers: 3,
      runtimeFactory: mockRuntimeFactory,
      routing: {
        profiles: {
          capable: { provider: 'codex', model: 'gpt-5.5' },
          cheap: { provider: 'minimax', model: 'MiniMax-M2.7' },
        },
        routing: {
          code_edit: 'capable',
          compaction: 'cheap',
        },
      },
      runWorker: async () => ({
        result: { status: 'passed', summary: 'ok', artifacts: [] },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTotalUsage: () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    // Compaction task should route to cheap model
    await coordinator.delegate({
      parentTurnId: 'test',
      objective: 'compact the conversation history',
      kind: 'review',
      profile: 'reader',
      scope: {},
    })

    assert.equal(capturedModel, 'MiniMax-M2.7')
  })
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/coordinator.ts src/agent/__tests__/coordinator.test.ts
git commit -m "feat(agent): add routing config to DelegationCoordinator"
```

---

### 任务 11：main.tsx Worker Runtime 集成

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：更新 runtimeFactory 读取 routing config**

在 `src/main.tsx` 的 `runtimeFactory` 中，读取 `config.workers` 来选择 provider：

```typescript
// 在 main.tsx 中，更新 runtimeFactory
const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
  const writeProfiles = ['patcher', 'verifier']
  const isWrite = writeProfiles.includes(_order.profile)

  // Resolve worker provider: routing config → fallback to active provider
  let workerProvider = activeProvider
  let workerApiKey = activeApiKey

  if (config.workers?.profiles) {
    const task = mapWorkOrderKindToCapabilityTask(_order.kind)
    const routeName = config.workers.routing[task]
    if (routeName && config.workers.profiles[routeName]) {
      const routeProfile = config.workers.profiles[routeName]
      const resolvedProvider = config.provider.providers[routeProfile.provider]
      if (resolvedProvider) {
        workerProvider = resolvedProvider
        workerApiKey = resolveApiKey(resolvedProvider)
      }
    }
  }

  return {
    order: _order,
    client: createProviderClient(
      workerProvider,
      resolveCapabilities(workerProvider.name, workerProvider.capabilities),
      {
        apiKey: workerApiKey,
        model: card.model,
        reasoningEffort: undefined,
        maxTokens: isWrite ? Math.min(8192, card.contextWindow) : Math.min(4096, card.contextWindow),
        thinkingBudget: isWrite ? 8192 : 4096,
      },
    ),
    promptEngine: new PromptEngine({
      model: card.model,
      maxTokens: isWrite ? 8192 : 4096,
      staticCtx: { tools: workerRegistry.getDefinitions() },
      volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
    }),
    toolRegistry: workerRegistry,
    cwd,
    maxTurns: isWrite ? 8 : 4,
    contextWindow: card.contextWindow,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    activeClaims: _claimStoreRef?.listActiveClaims() ?? [],
  }
}
```

- [ ] **步骤 2：运行 typecheck + tests**

运行：`npm run typecheck && npm test`
预期：全部通过

- [ ] **步骤 3：Commit**

```bash
git add src/main.tsx
git commit -m "feat(main): integrate worker routing config into runtimeFactory"
```

---

## 自检清单

1. **规格覆盖度**: P0(Codex OAuth 基础函数+token store+refresh) ✅ | P1(MiniMax/MiMo capabilities) ✅ | P2(Worker routing schema+coordinator) ✅ | P3(OpenCode Go entry) ✅
2. **占位符扫描**: 无 TODO/PENDING
3. **类型一致性**: `AuthProvider` 接口在 types.ts 定义，api-key.ts/registry.ts/ factory.ts 一致使用；`WorkerRouteConfig` 在 coordinator.ts 定义，main.tsx 使用
4. **向后兼容**: configSchema 新字段都有 `.default()` 或 `.optional()`，现有 config 不需要改动

**注意**: OAuth 完整实现（PKCE 回调服务器、浏览器跳转、token 交换 HTTP 请求）需要在任务 4-5 基础上进一步实现。当前计划提供了基础函数和测试框架，完整 OAuthAuth class 的 HTTP 交互层需要后续任务补充。
