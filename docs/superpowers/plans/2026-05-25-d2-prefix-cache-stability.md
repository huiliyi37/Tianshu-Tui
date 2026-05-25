# 缓存稳定与审计 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 prompt/cache 测试从易碎下标断言迁移到语义 selector，并增加 cache risk audit，提前发现会破坏 DeepSeek exact-prefix cache 的改动。

**架构：** 测试层新增 message selector helper，统一解析 trailer mode 的 latest user、historical user、tool results；cache 层新增纯函数 `auditCacheRisk()`，根据 changed files 和风险规则输出风险等级。审计函数只分析路径和变更类型，不调用 git。

**技术栈：** TypeScript strict、node:test、PromptEngine、OpenAI-native `OaiMessage`、DeepSeek prefix cache usage

---

> 总索引：`docs/superpowers/plans/2026-05-25-把这些写到计划里-可能文档太长了-分三个文档来做-d1-d2-d3.md`

## 1. Scope check

本计划只处理 prompt/cache 稳定性验证和风险审计：

| 范围 | 包含 | 不包含 |
|---|---|---|
| Prompt 测试表达 | latest user trailer、user/tool message selector、移除易碎下标断言 | 修改 PromptEngine 业务逻辑 |
| Cache 风险审计 | 根据 changed file path 判断 cache 风险等级 | 调用真实 git 或读取 diff 内容 |
| CLI 入口 | 接收文件路径参数并输出 HIGH/MEDIUM/LOW | CI pipeline 接入 |

独立性判断：该计划不改变工具输出行为，不改变 delivery gate；完成后能独立运行 prompt/cache 相关测试。

---

## 2. File structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/prompt/__tests__/helpers/message-selectors.ts` | prompt 测试语义 selector | 创建 |
| `src/prompt/__tests__/engine.test.ts:1-130` | 替换 trailer/session state 相关固定下标断言 | 修改 |
| `src/prompt/__tests__/engine-cache-stability.test.ts:1-40` | 复用 selector helper，删除重复 helper | 修改 |
| `src/cache/cache-audit.ts` | cache 风险审计纯函数 | 创建 |
| `src/cache/cache-audit-cli.ts` | cache audit 命令行入口 | 创建 |
| `src/cache/__tests__/cache-audit.test.ts` | cache audit 测试 | 创建 |
| `package.json` | 增加 `cache:audit` 脚本 | 修改 |

---

## 3. Tasks

### Task 1：创建 prompt message selector helper

**文件：**
- 创建：`src/prompt/__tests__/helpers/message-selectors.ts`
- 修改：`src/prompt/__tests__/engine.test.ts:1-130`

- [ ] **步骤 1：创建 helper 文件**

创建 `src/prompt/__tests__/helpers/message-selectors.ts`：

```typescript
import type { OaiMessage } from '../../../api/oai-types.js'

export interface LatestUserTrailer {
  fresh: string
  user: string
  message: OaiMessage
}

export function latestUserTrailer(messages: readonly OaiMessage[]): LatestUserTrailer {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user' && typeof msg.content === 'string') {
      const sep = '\n---\n'
      const idx = msg.content.indexOf(sep)
      if (idx === -1) return { fresh: msg.content, user: '', message: msg }
      return { fresh: msg.content.slice(0, idx), user: msg.content.slice(idx + sep.length), message: msg }
    }
  }
  throw new Error('expected at least one user message')
}

export function userMessages(messages: readonly OaiMessage[]): OaiMessage[] {
  return messages.filter(m => m.role === 'user')
}

export function toolMessages(messages: readonly OaiMessage[]): OaiMessage[] {
  return messages.filter(m => m.role === 'tool')
}
```

- [ ] **步骤 2：在 `engine.test.ts` 中添加 helper 行为测试**

在 `src/prompt/__tests__/engine.test.ts:1-130` 的 describe 内新增：

```typescript
it('message selector parses latest user trailer', () => {
  const parsed = latestUserTrailer([{ role: 'user', content: 'fresh\n---\nhello' }])
  assert.equal(parsed.fresh, 'fresh')
  assert.equal(parsed.user, 'hello')
})

it('message selector rejects message lists without user messages', () => {
  assert.throws(() => latestUserTrailer([{ role: 'assistant', content: 'x' }]), /expected at least one user message/)
})
```

并在文件顶部导入：

```typescript
import { latestUserTrailer } from './helpers/message-selectors.js'
```

- [ ] **步骤 3：运行测试确认通过**

```bash
npx tsx --test src/prompt/__tests__/engine.test.ts
```

预期结果：PromptEngine tests 全部 pass。

- [ ] **步骤 4：提交 helper**

```bash
git add src/prompt/__tests__/helpers/message-selectors.ts src/prompt/__tests__/engine.test.ts
git commit -m "test(prompt): add semantic message selectors"
```

预期结果：生成 helper 提交。

---

### Task 2：迁移 PromptEngine 测试到语义 selector

**文件：**
- 修改：`src/prompt/__tests__/engine.test.ts:78-130`
- 修改：`src/prompt/__tests__/engine-cache-stability.test.ts:1-40`
- 测试：`src/prompt/__tests__/engine.test.ts`
- 测试：`src/prompt/__tests__/engine-cache-stability.test.ts`

- [ ] **步骤 1：修改 session state refresh 测试**

将 `src/prompt/__tests__/engine.test.ts:78-100` 中查找最新 user 的逻辑统一改为：

```typescript
const { fresh, user } = latestUserTrailer(request.messages)
assert.match(fresh, /state v2/)
assert.equal(user, 'continue')
```

- [ ] **步骤 2：复用 helper 到 cache stability 测试**

在 `src/prompt/__tests__/engine-cache-stability.test.ts:1-40` 删除本地 `latestUserTrailer` 函数，并添加：

```typescript
import { latestUserTrailer } from './helpers/message-selectors.js'
```

保留本地 `stringContent()`，因为它服务于非 trailer content 的断言。

- [ ] **步骤 3：检查易碎下标断言**

运行：

```bash
grep -R -n "request\.messages\[[0-9]" src/prompt/__tests__
```

预期结果：输出只允许保留明确测试 cache anchor 或 system/user ordering 的位置断言。每条保留行必须在代码旁边有注释说明，例如：

```typescript
// Intentional positional assertion: system message must remain first for OpenAI-native request shape.
```

- [ ] **步骤 4：运行 prompt 相关测试**

```bash
npx tsx --test src/prompt/__tests__/engine.test.ts
npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
```

预期结果：两个测试文件全部 pass。

- [ ] **步骤 5：提交测试迁移**

```bash
git add src/prompt/__tests__/engine.test.ts src/prompt/__tests__/engine-cache-stability.test.ts
git commit -m "test(prompt): replace brittle message indexes"
```

预期结果：生成测试迁移提交。

---

### Task 3：创建 cache risk audit 纯函数

**文件：**
- 创建：`src/cache/cache-audit.ts`
- 创建：`src/cache/__tests__/cache-audit.test.ts`

- [ ] **步骤 1：创建失败测试**

创建 `src/cache/__tests__/cache-audit.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { auditCacheRisk } from '../cache-audit.js'

describe('auditCacheRisk', () => {
  it('reports high risk for prompt engine changes', () => {
    const report = auditCacheRisk({ changedFiles: ['src/prompt/engine.ts'] })
    assert.equal(report.level, 'high')
    assert.equal(report.findings[0]?.level, 'high')
    assert.match(report.findings[0]?.reason ?? '', /request message layout/)
  })

  it('reports medium risk for tool result changes', () => {
    const report = auditCacheRisk({ changedFiles: ['src/tools/read-file.ts'] })
    assert.equal(report.level, 'medium')
    assert.equal(report.findings[0]?.level, 'medium')
  })

  it('uses the highest risk as report level', () => {
    const report = auditCacheRisk({ changedFiles: ['README.md', 'src/tools/grep.ts', 'src/prompt/static.ts'] })
    assert.equal(report.level, 'high')
    assert.equal(report.findings.length, 3)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npx tsx --test src/cache/__tests__/cache-audit.test.ts
```

预期结果：失败，错误包含 `Cannot find module '../cache-audit.js'`。

- [ ] **步骤 3：实现 `cache-audit.ts`**

创建 `src/cache/cache-audit.ts`：

```typescript
export type CacheRiskLevel = 'low' | 'medium' | 'high'

export interface CacheAuditInput {
  changedFiles: string[]
}

export interface CacheAuditFinding {
  file: string
  level: CacheRiskLevel
  reason: string
}

export interface CacheAuditReport {
  level: CacheRiskLevel
  findings: CacheAuditFinding[]
}

function levelRank(level: CacheRiskLevel): number {
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}

function findingFor(file: string): CacheAuditFinding {
  if (file === 'src/prompt/static.ts') {
    return { file, level: 'high', reason: 'system prompt changes invalidate static prefix' }
  }
  if (file === 'src/prompt/engine.ts') {
    return { file, level: 'high', reason: 'request message layout may change prefix stability' }
  }
  if (file === 'src/agent/compaction-controller.ts') {
    return { file, level: 'high', reason: 'replaceMessages/session split can rewrite history' }
  }
  if (/^src\/tools\/[^/]+\.ts$/.test(file)) {
    return { file, level: 'medium', reason: 'tool result content can change future history' }
  }
  if (/^src\/compact\/[^/]+\.ts$/.test(file)) {
    return { file, level: 'medium', reason: 'pruning or masking can change request payload' }
  }
  return { file, level: 'low', reason: 'no known direct cache risk' }
}

export function auditCacheRisk(input: CacheAuditInput): CacheAuditReport {
  const findings = input.changedFiles.map(findingFor)
  const level = findings.reduce<CacheRiskLevel>((max, f) => levelRank(f.level) > levelRank(max) ? f.level : max, 'low')
  return { level, findings }
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
npx tsx --test src/cache/__tests__/cache-audit.test.ts
```

预期结果：3 tests pass。

- [ ] **步骤 5：提交 audit 纯函数**

```bash
git add src/cache/cache-audit.ts src/cache/__tests__/cache-audit.test.ts
git commit -m "feat(cache): add cache risk audit"
```

预期结果：生成 cache audit 提交。

---

### Task 4：添加 cache audit CLI 和 npm script

**文件：**
- 创建：`src/cache/cache-audit-cli.ts`
- 修改：`package.json`
- 测试：`src/cache/__tests__/cache-audit.test.ts`

- [ ] **步骤 1：创建 CLI 文件**

创建 `src/cache/cache-audit-cli.ts`：

```typescript
import { auditCacheRisk } from './cache-audit.js'

const changedFiles = process.argv.slice(2)
const report = auditCacheRisk({ changedFiles })

for (const finding of report.findings) {
  console.log(`${finding.level.toUpperCase()} ${finding.file} ${finding.reason}`)
}
console.log(`OVERALL ${report.level.toUpperCase()}`)
```

- [ ] **步骤 2：修改 package script**

在 `package.json` 的 `scripts` 中新增：

```json
"cache:audit": "tsx src/cache/cache-audit-cli.ts"
```

如果 scripts 当前按业务分组排列，将 `cache:audit` 放在 test/typecheck 附近。

- [ ] **步骤 3：运行 CLI 验证**

```bash
npm run cache:audit -- src/prompt/engine.ts src/tools/read-file.ts
```

预期结果包含：

```txt
HIGH src/prompt/engine.ts request message layout may change prefix stability
MEDIUM src/tools/read-file.ts tool result content can change future history
OVERALL HIGH
```

- [ ] **步骤 4：运行 typecheck**

```bash
npx tsc --noEmit
```

预期结果：TypeScript 0 errors。

- [ ] **步骤 5：提交 CLI**

```bash
git add src/cache/cache-audit-cli.ts package.json
git commit -m "chore(cache): add cache audit script"
```

预期结果：生成 CLI 提交。

---

## 4. Verification

```bash
npx tsx --test src/prompt/__tests__/engine.test.ts
# 预期：PromptEngine tests 全部 pass

npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts
# 预期：cache stability tests 全部 pass

npx tsx --test src/cache/__tests__/cache-audit.test.ts
# 预期：cache audit tests 全部 pass

npm run cache:audit -- src/prompt/engine.ts src/tools/read-file.ts
# 预期：输出 HIGH、MEDIUM、OVERALL HIGH

npx tsc --noEmit
# 预期：TypeScript 0 errors
```

---

## 5. Self-check

1. **Spec coverage:**
   - 测试避免下标脆弱性 → Task 1、Task 2。
   - cache 风险提前审计 → Task 3、Task 4。
   - 不修改 PromptEngine 业务逻辑 → Scope check 明确排除。
   - 每步独立可测 → 每个 Task 都有命令和提交。

2. **Placeholder scan:**
   - 本计划不包含禁用占位语句。
   - 所有函数名、类型名、路径、脚本名均在任务中定义。

3. **Type consistency:**
   - `LatestUserTrailer` 字段 `fresh/user/message` 与 helper 返回一致。
   - `CacheRiskLevel` 只允许 `low | medium | high`，CLI 输出通过 `toUpperCase()` 转换。
   - `auditCacheRisk()` 输入只依赖 `changedFiles`，测试和 CLI 调用一致。

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-25-d2-prefix-cache-stability.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
