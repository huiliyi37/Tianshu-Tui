# P2-15: Chat Prefix Completion 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 利用 DeepSeek Beta API 的 prefix completion 功能，在代码生成场景中注入 assistant prefix message，强制模型直接输出代码，省 30%+ output tokens。

**架构：** 在 `StreamClient.send()` 构建请求体时，根据配置和上下文判断是否注入 `{ role: "assistant", content: "```...\n", prefix: true }` 作为最后一条 message。仅对 DeepSeek provider 且 tool_choice 非 required 时生效。

**技术栈：** TypeScript / OpenAI-compatible API / DeepSeek Beta prefix feature

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/api/prefix-completion.ts` | 判断是否应注入 prefix + 生成 prefix content |
| `src/api/openai-client.ts` | 在 send() 中调用 prefix logic |
| `src/api/__tests__/prefix-completion.test.ts` | 单元测试 |
| `src/config/schema.ts` | 新增 `prefixCompletion` 配置项 |

---

### 任务 1：Prefix 判断逻辑

**文件：**
- 创建：`src/api/prefix-completion.ts`
- 测试：`src/api/__tests__/prefix-completion.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldInjectPrefix, buildPrefixMessage } from '../prefix-completion.js'

describe('prefix-completion', () => {
  describe('shouldInjectPrefix', () => {
    it('returns true for deepseek provider without tool_choice', () => {
      assert.equal(shouldInjectPrefix({ provider: 'deepseek', hasToolChoice: false, enabled: true }), true)
    })

    it('returns false when tool_choice is set', () => {
      assert.equal(shouldInjectPrefix({ provider: 'deepseek', hasToolChoice: true, enabled: true }), false)
    })

    it('returns false for non-deepseek provider', () => {
      assert.equal(shouldInjectPrefix({ provider: 'mimo', hasToolChoice: false, enabled: true }), false)
    })

    it('returns false when disabled', () => {
      assert.equal(shouldInjectPrefix({ provider: 'deepseek', hasToolChoice: false, enabled: false }), false)
    })
  })

  describe('buildPrefixMessage', () => {
    it('returns assistant message with prefix flag', () => {
      const msg = buildPrefixMessage()
      assert.equal(msg.role, 'assistant')
      assert.equal(msg.prefix, true)
      assert.equal(typeof msg.content, 'string')
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/api/__tests__/prefix-completion.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现**

```typescript
export interface PrefixDecisionInput {
  provider: string
  hasToolChoice: boolean
  enabled: boolean
}

export function shouldInjectPrefix(input: PrefixDecisionInput): boolean {
  return input.enabled && input.provider === 'deepseek' && !input.hasToolChoice
}

export interface PrefixMessage {
  role: 'assistant'
  content: string
  prefix: true
}

export function buildPrefixMessage(): PrefixMessage {
  return { role: 'assistant', content: '', prefix: true }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/api/__tests__/prefix-completion.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/api/prefix-completion.ts src/api/__tests__/prefix-completion.test.ts
git commit -m "feat(api): add prefix completion decision logic"
```

---

### 任务 2：集成到 StreamClient

**文件：**
- 修改：`src/api/openai-client.ts`（send 方法中，构建 body 后、发送前）
- 修改：`src/config/schema.ts`（新增配置项）

- [ ] **步骤 1：在 config schema 中添加 prefixCompletion 选项**

在 `providerCapabilitiesSchema` 中添加：

```typescript
prefixCompletion: z.boolean().default(false),
```

- [ ] **步骤 2：在 StreamClient.send() 中注入 prefix message**

在 `openai-client.ts` 的 `send()` 方法中，body 构建完成后、fetch 调用前，添加：

```typescript
import { shouldInjectPrefix, buildPrefixMessage } from './prefix-completion.js'

// After body is built, before fetch:
if (shouldInjectPrefix({
  provider: this.config.providerName,
  hasToolChoice: !!body.tool_choice,
  enabled: this.config.capabilities?.prefixCompletion ?? false,
})) {
  ;(body.messages as unknown[]).push(buildPrefixMessage())
}
```

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npx tsx --test src/api/__tests__/prefix-completion.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/api/openai-client.ts src/config/schema.ts
git commit -m "feat(api): integrate prefix completion into StreamClient"
```

---

### 任务 3：验证 prefix cache 不受影响

- [ ] **步骤 1：运行现有 fingerprint 测试**

运行：`npx tsx --test src/prompt/__tests__/fingerprint.test.ts`
预期：PASS（prefix message 在 messages 末尾，不影响 system prompt fingerprint）

- [ ] **步骤 2：运行全量测试确认无回归**

运行：`npm test`
预期：2808+ pass
