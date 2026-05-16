# Rivet Tool Safety + Verification Evidence 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立 Rivet 的工具安全策略与验证证据闭环，让高影响工具可解释、可阻断，修改交付必须带有 pass/fail/blocked/unverified evidence。

**架构：** 新增独立 `ToolSafetyPolicy` 作为 approval、hooks、cockpit 的共同风险来源；修复 `web_fetch` redirect 后 SSRF 校验；扩展 verification/evidence 状态，使 `run_tests` 失败或 blocked 也进入 EvidenceTracker。AgentLoop 在 final badge 与 TUI 中暴露统一交付状态。

**技术栈：** TypeScript, node:test, node:assert/strict, existing `AgentLoop`, `assessToolRisk`, `EvidenceTracker`, `RUN_TESTS_TOOL`, `WEB_FETCH_TOOL`, Ink cockpit panels

---

## 背景

Rivet 的核心业务不是只调用工具，而是安全、可信地调用工具。当前已有 approval mode、hook registry、approval-risk card、run_tests verification metadata、EvidenceTracker，但它们还不是闭环：

- 高风险判断在 `AgentLoop.isHighRisk()` 与 `src/agent/approval-risk.ts` 之间分散。
- `web_fetch` redirect 后的目标需要重新执行 SSRF/private IP 校验。
- `run_tests` 失败或 blocked 的 metadata 可能没有进入 EvidenceTracker。
- 有文件修改但未验证时，最终输出需要明确显示 verification gap。

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/agent/approval-risk.ts` | 升级为统一 ToolSafetyPolicy，输出结构化风险原因和建议动作 |
| 修改 | `src/agent/__tests__/approval-risk.test.ts` | 覆盖 destructive bash、force push、absolute path、web fetch URL、rollback/undo |
| 修改 | `src/tools/web-fetch.ts` | redirect 后重新校验目标 URL/IP |
| 修改 | `src/tools/__tests__/web-fetch.test.ts` | 覆盖 redirect 到 private IP 被拒绝 |
| 修改 | `src/agent/evidence.ts` | 记录 passed/failed/blocked/unverified verification 状态 |
| 修改 | `src/agent/__tests__/evidence.test.ts` | 覆盖 verification gap 与 failed/blocked badge |
| 修改 | `src/agent/loop.ts` | 使用 ToolSafetyPolicy；确保 run_tests metadata 无论 pass/fail/blocked 都进入 EvidenceTracker |
| 修改 | `src/agent/__tests__/loop.test.ts` | 覆盖 failed run_tests 也记录 verification，edit 后无验证产生 gap |
| 修改 | `src/tui/cockpit/safety-panel.tsx` | 展示 risk reason 和 suggested action |
| 修改 | `src/tui/cockpit/verification-panel.tsx` | 展示 verified/failed/blocked/unverified delivery state |
| 修改 | `src/tui/cockpit/__tests__/panels.test.ts` | 覆盖 safety + verification panel 文案 |
| 修改 | `README.md` | 补充 tool safety 与 evidence gate 说明 |

---

### 任务 1：统一工具风险评估模型

**文件：**
- 修改：`src/agent/approval-risk.ts`
- 测试：`src/agent/__tests__/approval-risk.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/approval-risk.test.ts` 增加：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessToolRisk } from '../approval-risk.js'

describe('assessToolRisk', () => {
  it('flags destructive shell commands with reason and suggested action', () => {
    const risk = assessToolRisk('bash', { command: 'git reset --hard HEAD~1' })
    assert.equal(risk.level, 'high')
    assert.ok(risk.reasons.some(reason => reason.includes('destructive')))
    assert.match(risk.suggestedAction, /approval/i)
  })

  it('flags force push as high risk', () => {
    const risk = assessToolRisk('bash', { command: 'git push --force origin main' })
    assert.equal(risk.level, 'high')
    assert.ok(risk.reasons.some(reason => reason.includes('force push')))
  })

  it('flags absolute path writes as medium risk', () => {
    const risk = assessToolRisk('write_file', { file_path: '/tmp/outside.txt', content: 'x' })
    assert.equal(risk.level, 'medium')
    assert.ok(risk.reasons.some(reason => reason.includes('absolute path')))
  })

  it('treats safe read_file as low risk', () => {
    const risk = assessToolRisk('read_file', { file_path: 'src/main.tsx' })
    assert.equal(risk.level, 'low')
    assert.deepEqual(risk.reasons, [])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/approval-risk.test.ts
```

预期：FAIL，当前 `RiskAssessment` 缺少 `reasons` 或 `suggestedAction`。

- [x] **步骤 3：实现结构化风险模型**

修改 `src/agent/approval-risk.ts`：

```typescript
export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
  suggestedAction: string
}

const DESTRUCTIVE_COMMAND = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-|killall|pkill|drop\s+table)\b/i
const FORCE_PUSH = /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i

export function assessToolRisk(toolName: string, input: Record<string, unknown>): RiskAssessment {
  const reasons: string[] = []

  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (DESTRUCTIVE_COMMAND.test(command)) reasons.push('destructive shell command')
    if (FORCE_PUSH.test(command)) reasons.push('force push can overwrite shared remote history')
  }

  const paths = [input.file_path, input.path, input.target].filter((value): value is string => typeof value === 'string')
  if (paths.some(path => path.startsWith('/'))) reasons.push('absolute path target')
  if (paths.some(path => path.split('/').includes('..'))) reasons.push('path traversal target')
  if (toolName === 'rollback' || toolName === 'undo') reasons.push('state rollback changes working tree')

  const level: RiskLevel = reasons.some(reason => reason.includes('destructive') || reason.includes('force push') || reason.includes('rollback'))
    ? 'high'
    : reasons.length > 0
      ? 'medium'
      : 'low'

  return {
    level,
    reasons,
    suggestedAction: level === 'high'
      ? 'Require explicit user approval before execution.'
      : level === 'medium'
        ? 'Show risk context and proceed only in auto-safe/manual modes.'
        : 'No additional approval required.',
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/approval-risk.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/approval-risk.ts src/agent/__tests__/approval-risk.test.ts
git commit -m "feat(agent): structure tool safety risk assessment"
```

---

### 任务 2：修复 web_fetch redirect SSRF 校验

**文件：**
- 修改：`src/tools/web-fetch.ts`
- 测试：`src/tools/__tests__/web-fetch.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/tools/__tests__/web-fetch.test.ts` 增加：

```typescript
it('rejects redirects to private IP addresses', async () => {
  const result = await WEB_FETCH_TOOL.execute(makeParams({
    url: 'https://example.com/redirect-private',
  }, {
    fetch: async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1:8080/admin' },
    }),
    resolveHostname: async () => ['93.184.216.34'],
  }))

  assert.equal(result.isError, true)
  assert.match(result.content, /private|localhost|SSRF/i)
})
```

If the test helper in the file does not support dependency injection, add a local helper that matches the existing `WEB_FETCH_TOOL.execute()` parameter style and injects fetch/resolve through the tool input or module-level test seam used by existing tests.

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tools/__tests__/web-fetch.test.ts
```

预期：FAIL，redirect target is not rejected.

- [x] **步骤 3：重新校验 redirect target**

In `src/tools/web-fetch.ts`, ensure every redirect location is normalized and passed through the same URL/IP validation as the original URL before fetching the next response:

```typescript
async function validateFetchUrl(url: URL, resolveHostname: (hostname: string) => Promise<string[]>): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Blocked unsupported protocol: ${url.protocol}`
  }
  const addresses = await resolveHostname(url.hostname)
  if (addresses.some(isPrivateIP)) {
    return `Blocked potential SSRF target: ${url.hostname}`
  }
  return undefined
}
```

Before following redirect:

```typescript
const location = response.headers.get('location')
if (location && response.status >= 300 && response.status < 400) {
  const nextUrl = new URL(location, currentUrl)
  const validationError = await validateFetchUrl(nextUrl, resolveHostname)
  if (validationError) return { content: `Error: ${validationError}`, isError: true }
  currentUrl = nextUrl
  continue
}
```

Use existing helper names if `web-fetch.ts` already has equivalent `validateUrl` / `resolveHostname` functions; do not duplicate two validators.

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tools/__tests__/web-fetch.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tools/web-fetch.ts src/tools/__tests__/web-fetch.test.ts
git commit -m "fix(web-fetch): validate redirect targets against SSRF"
```

---

### 任务 3：让 EvidenceTracker 记录失败和阻塞验证

**文件：**
- 修改：`src/agent/evidence.ts`
- 测试：`src/agent/__tests__/evidence.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/evidence.test.ts` 增加：

```typescript
it('reports failed verification in the evidence badge', () => {
  const tracker = new EvidenceTracker()
  tracker.trackFileModified('src/agent/loop.ts')
  tracker.trackVerification({
    command: 'npm test -- src/agent/__tests__/loop.test.ts',
    status: 'failed',
    scope: 'targeted',
    target: 'src/agent/__tests__/loop.test.ts',
  })

  const badge = tracker.buildBadge()
  assert.match(badge, /verification failed/i)
  assert.match(badge, /loop\.test\.ts/)
})

it('reports unverified edits when files changed without verification', () => {
  const tracker = new EvidenceTracker()
  tracker.trackFileModified('src/tools/web-fetch.ts')

  const badge = tracker.buildBadge()
  assert.match(badge, /unverified/i)
  assert.match(badge, /web-fetch\.ts/)
})
```

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/evidence.test.ts
```

预期：FAIL，badge does not include failed/unverified delivery state.

- [x] **步骤 3：扩展 EvidenceTracker 状态**

修改 `src/agent/evidence.ts`，确保 state 包含 verification statuses:

```typescript
export type DeliveryVerificationStatus = 'verified' | 'failed' | 'blocked' | 'unverified'

export interface EvidenceState {
  filesRead: string[]
  filesModified: string[]
  verificationRuns: VerificationMetadata[]
  deliveryStatus: DeliveryVerificationStatus
}
```

Update `getState()` / `buildBadge()` logic:

```typescript
private deliveryStatus(): DeliveryVerificationStatus {
  if (this.state.verificationRuns.some(run => run.status === 'failed')) return 'failed'
  if (this.state.verificationRuns.some(run => run.status === 'blocked')) return 'blocked'
  if (this.state.filesModified.length > 0 && this.state.verificationRuns.length === 0) return 'unverified'
  if (this.state.verificationRuns.some(run => run.status === 'passed')) return 'verified'
  return 'unverified'
}
```

Badge text should include:

```typescript
const status = this.deliveryStatus()
const label = status === 'verified'
  ? 'verification passed'
  : status === 'failed'
    ? 'verification failed'
    : status === 'blocked'
      ? 'verification blocked'
      : 'unverified changes'
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/evidence.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/evidence.ts src/agent/__tests__/evidence.test.ts
git commit -m "feat(agent): surface failed and missing verification evidence"
```

---

### 任务 4：AgentLoop 使用统一风险模型并记录所有 run_tests metadata

**文件：**
- 修改：`src/agent/loop.ts`
- 测试：`src/agent/__tests__/loop.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/loop.test.ts` 增加：

```typescript
it('tracks failed run_tests verification metadata', async () => {
  const loop = makeLoopWithToolResult('run_tests', {
    content: 'Tests failed',
    isError: true,
    verification: {
      command: 'npm test -- src/agent/__tests__/loop.test.ts',
      status: 'failed',
      scope: 'targeted',
      target: 'src/agent/__tests__/loop.test.ts',
    },
  })

  await loop.run('run tests', makeCallbacks())

  const state = loop.getEvidenceState()
  assert.equal(state.verificationRuns.length, 1)
  assert.equal(state.verificationRuns[0]!.status, 'failed')
})
```

Use existing mock helpers from `loop.test.ts`; if helper names differ, build a minimal mock `ToolRegistry` that returns the shown `ToolResult`.

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
```

预期：FAIL，failed `run_tests` metadata is not tracked.

- [x] **步骤 3：修改 AgentLoop**

In `src/agent/loop.ts`, import and use structured risk:

```typescript
import { assessToolRisk } from './approval-risk.js'
```

Replace high-risk check logic with:

```typescript
const risk = assessToolRisk(tu.name, tu.input)
const isHighRisk = needsApproval && risk.level === 'high'
```

Move run_tests verification tracking outside the `!harnessResult.isError` branch:

```typescript
if (tu.name === 'run_tests' && rawToolResult?.verification) {
  this.evidence.trackVerification(rawToolResult.verification)
}

if (tu.name === 'read_file' && !harnessResult.isError) {
  this.evidence.trackFileRead(tu.input.file_path as string)
} else if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError) {
  this.evidence.trackFileModified(tu.input.file_path as string)
}
```

Keep failure diagnosis logic after verification tracking:

```typescript
if (tu.name === 'run_tests' && rawToolResult?.verification && rawToolResult.verification.status !== 'passed') {
  const failures = classifyTestRun(harnessResult.content)
  // existing diagnosis push logic
}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts src/agent/__tests__/approval-risk.test.ts src/agent/__tests__/evidence.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "fix(agent): track failed verification and use safety policy"
```

---

### 任务 5：更新 Cockpit safety / verification panels

**文件：**
- 修改：`src/tui/cockpit/safety-panel.tsx`
- 修改：`src/tui/cockpit/verification-panel.tsx`
- 修改：`src/tui/cockpit/types.ts`
- 测试：`src/tui/cockpit/__tests__/panels.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `src/tui/cockpit/__tests__/panels.test.ts` 增加：

```typescript
it('renders safety risk reasons and suggested action', () => {
  const output = renderToString(<SafetyPanel state={{
    doomLoopLevel: 'none',
    currentRisk: {
      level: 'high',
      reasons: ['force push can overwrite shared remote history'],
      suggestedAction: 'Require explicit user approval before execution.',
    },
  }} />)

  assert.match(output, /force push/)
  assert.match(output, /approval/i)
})

it('renders blocked verification delivery state', () => {
  const output = renderToString(<VerificationPanel state={{
    deliveryStatus: 'blocked',
    runs: [{ command: 'npm test', status: 'blocked', scope: 'full' }],
  }} />)

  assert.match(output, /blocked/i)
  assert.match(output, /npm test/)
})
```

Adapt prop wrappers to the existing panel test style.

- [x] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/panels.test.ts
```

预期：FAIL，panels do not render new fields.

- [x] **步骤 3：扩展 panel types and rendering**

In `src/tui/cockpit/types.ts` add:

```typescript
export interface CockpitRiskView {
  level: 'low' | 'medium' | 'high'
  reasons: string[]
  suggestedAction: string
}

export interface CockpitVerificationRunView {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: string
  target?: string
}

export interface CockpitVerificationState {
  deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
  runs: CockpitVerificationRunView[]
}
```

In `safety-panel.tsx`, render reasons/action:

```tsx
{state.currentRisk && (
  <Box flexDirection="column">
    <Text>Risk: {state.currentRisk.level}</Text>
    {state.currentRisk.reasons.map(reason => <Text key={reason}>- {reason}</Text>)}
    <Text>{state.currentRisk.suggestedAction}</Text>
  </Box>
)}
```

In `verification-panel.tsx`, render delivery status and run commands:

```tsx
<Text>Delivery: {state.deliveryStatus}</Text>
{state.runs.map(run => (
  <Text key={`${run.command}:${run.status}`}>{run.status} · {run.command}</Text>
))}
```

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/cockpit/__tests__/panels.test.ts
```

预期：PASS。

- [x] **步骤 5：Commit**

```bash
git add src/tui/cockpit/safety-panel.tsx src/tui/cockpit/verification-panel.tsx src/tui/cockpit/types.ts src/tui/cockpit/__tests__/panels.test.ts
git commit -m "feat(tui): show tool risk and delivery verification state"
```

---

### 任务 6：README 与最终验证

**文件：**
- 修改：`README.md`

- [x] **步骤 1：更新 README**

在 README 的工具安全/验证章节加入：

```markdown
### Tool Safety and Evidence

Rivet treats tool execution as a security boundary. High-impact tools are assessed with a shared risk policy that feeds approval prompts, hooks, and the cockpit safety panel. Verification results are recorded even when tests fail or are blocked, so final responses can distinguish verified, failed, blocked, and unverified changes.

Before claiming completion after edits, Rivet should surface:

- files changed
- verification commands run
- pass/fail/blocked status
- unverified-change warnings when no relevant verification ran
```

- [x] **步骤 2：运行完整验证**

运行：

```bash
npm run typecheck
npm test
npm run build
```

预期：全部 PASS。

- [x] **步骤 3：检查没有真实 secrets**

运行：

```bash
git diff -- src docs README.md | grep -Ei "sk-[a-zA-Z0-9]|api[_-]?key\s*=|password\s*=|secret\s*=" || true
```

预期：无真实密钥或 credential 片段命中。

- [x] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: describe tool safety and evidence gates"
```

---

## 自检

### 规格覆盖度

- ToolSafetyPolicy：任务 1 + 4 覆盖。
- web_fetch redirect SSRF：任务 2 覆盖。
- failed/blocked verification metadata：任务 3 + 4 覆盖。
- TUI safety/verification 可见性：任务 5 覆盖。
- README 与完整验证：任务 6 覆盖。

### 占位符扫描

本文没有留下未具体化的占位描述；每个代码任务都包含具体测试、实现片段、命令和预期输出。

### 类型一致性

- `RiskAssessment.reasons` 和 `RiskAssessment.suggestedAction` 在任务 1 定义，在任务 4 和任务 5 使用。
- `DeliveryVerificationStatus` 在任务 3 定义，在任务 5 的 cockpit view 中以同名 union 展示。
- `VerificationMetadata.status` 继续使用现有 passed/failed/blocked 语义，不引入第二套 run status。

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-tool-safety-verification-evidence.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
