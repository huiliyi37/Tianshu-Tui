# /council 工具门控错配修复（workflow 声明所需 EXTENDED 工具 + 提交路径自动挂载） 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复会话 `5158719d` 暴露的议事会失效：`/council` 的 workflow prompt 强制指示模型「直接调用 council_convene 工具」，但 `council_convene` 在 EXTENDED 层（2026-07-01 工具门控默认开启后主控不可见）——模型调不到，被迫用 `delegate_batch` 模拟议事会，超时后自己编造三席评审。`/team` 有同样的错配（prompt 指示 `team_orchestrate`，同为 EXTENDED）。

**架构：** 让 workflow 解析层**声明**自己需要哪些 EXTENDED 工具（`WorkflowResolveResult.requiredTools`），TUI 提交路径在发起 run 前经现有的 `agent.enableTool()`（`loop.ts:854`，幂等、带缓存影响报告）自动挂载并向用户播报一行挂载通知。prompt 与工具可见性从此由同一个解析结果保证一致，不可能再漂移。

**技术栈：** TypeScript strict / node:test + node:assert/strict / 无新依赖。

---

## 前置事实（已核实，2026-07-02）

- **错配三角**：
  - `src/workflows/ecosystem-workflows.ts:403-404`：`/council` prompt「不要再问是否使用,直接调用 council_convene 工具」
  - `src/agent/tool-tiers.ts:63-64`：`council_convene`、`team_orchestrate` 都在 `EXTENDED_TOOLS` → 默认门控下从主控 `getDefinitions()` 摘除
  - 会话实录：模型 grep 源码确认工具不可见 → 改调 `delegate_batch` → 210s 超时 → 自行模拟输出
- **`/council` 的二段式契约放大了问题**：prompt L409 要求用户确认后「原样作为 team_orchestrate 的 planJson 参数发起执行」——即使 council_convene 挂上了，执行交接还需要 `team_orchestrate` 可见。所以 `/council` 需要挂载**两个**工具。
- **挂载机制现成**：`agent.enableTool(name)`（`loop.ts:854-858`）返回 `{ status: 'mounted'|'already-active'|'not-extended'|'unknown'|'gating-off', cacheImpact, prefixCacheStrategy }`，幂等，已有完整测试（`tool-gating-escape-hatch.test.ts`）。`/tools enable` 的播报文案在 `slash-commands.ts:475-479` 可参考。
- **调用链**：`main.ts:850` `resolveAppPromptInput(trimmed, cwd)`（返回 `string | null`）→ `main.ts:862` `ctx.agent.run(prompt, callbacks)`。`ctx.agent` 是 AgentLoop，`enableTool` 直接可调。`resolveAppPromptInput` 的生产调用方**只有 main.ts 这一处**（其余是测试）。
- **`WorkflowResolveResult`**：`ecosystem-workflows.ts:22-25`，当前只有 `command` + `prompt`。
- **桌面端不受影响**：桌面 CouncilSurface 走专用 HTTP 路由 `POST /sessions/:id/council` → `conveneCouncil()`（`session-manager.ts:284`，I1），不经过模型工具调用，无门控问题。桌面聊天输入框敲 `/council` 文本不做 slash 解析（sidecar 无 resolveAppPromptInput 调用）——那是另一个特性缺口，**不在本计划范围**。
- **挂载的缓存代价可接受**：EXTENDED 挂载改变工具定义 → prefix-cache 一次性 MISS（deepseek-native/anthropic 策略下）。发生在用户显式发起 `/council` 的消息边界，属于用户主动换挡，与 `/tools enable` 同一代价模型，需要播报但不需要确认。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/workflows/ecosystem-workflows.ts` | 修改 | `WorkflowResolveResult` 增加 `requiredTools`；/council、/team 声明各自所需 |
| `src/workflows/__tests__/ecosystem-workflows.test.ts` | 修改 | requiredTools 断言 |
| `src/tui/slash-commands.ts` | 修改 | `resolveAppPromptInput` 返回结构升级（携带 requiredTools） |
| `src/tui/__tests__/slash-commands.test.ts`（如有） | 修改 | 返回结构断言；先 `rg 'resolveAppPromptInput' src --glob '**/__tests__/**'` 核实现有测试位置 |
| `src/main.ts` | 修改 | onSubmit 提交前挂载 requiredTools + 播报 |

---

## 任务 1：workflow 解析层声明 requiredTools（TDD）

**文件：**
- 修改：`src/workflows/ecosystem-workflows.ts`、`src/workflows/__tests__/ecosystem-workflows.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
it('/council 声明 council_convene + team_orchestrate 为必需工具', () => {
  const resolved = resolveEcosystemWorkflowInput('/council 审查回滚方案')
  assert.deepEqual(resolved?.requiredTools, ['council_convene', 'team_orchestrate'])
})

it('/council 用法提示（空参数）不声明工具——没有真实调用发生', () => {
  const resolved = resolveEcosystemWorkflowInput('/council')
  assert.equal(resolved?.requiredTools, undefined)
})

it('/team 声明 team_orchestrate 为必需工具', () => {
  const resolved = resolveEcosystemWorkflowInput('/team docs/superpowers/plans/x.md')
  assert.deepEqual(resolved?.requiredTools, ['team_orchestrate'])
})

it('/plan 等纯 prompt workflow 不声明工具', () => {
  const resolved = resolveEcosystemWorkflowInput('/plan add feature', { date: new Date(2026, 6, 2) })
  assert.equal(resolved?.requiredTools, undefined)
})
```

- [ ] **步骤 2：实现**

```typescript
export interface WorkflowResolveResult {
  command: string
  prompt: string
  /**
   * prompt 指示模型直接调用、但位于 EXTENDED 层的工具。
   * 调用方（TUI 提交路径）负责在发起 run 前经 agent.enableTool() 挂载，
   * 保证 prompt 契约与工具可见性由同一个解析结果背书（会话 5158719d：
   * /council 指示调 council_convene 而门控把它摘了 → 模型被迫模拟议事会）。
   */
  requiredTools?: readonly string[]
}
```

- `/council`（`parseCouncilWorkflowArgs` 成功分支）→ `requiredTools: ['council_convene', 'team_orchestrate']`（council 出计划 + 用户确认后 team_orchestrate 交接执行，见 prompt L409 契约）
- `/council` usage 分支（空参数）→ 不带 requiredTools
- `/team`（成功与 usage 分支同理）→ `requiredTools: ['team_orchestrate']`

- [ ] **步骤 3：验证 + 提交**

```bash
npx tsc --noEmit && node --import tsx --test-force-exit --test src/workflows/__tests__/ecosystem-workflows.test.ts
```

提交：`feat(workflows): declare required EXTENDED tools on /council and /team resolution`

---

## 任务 2：resolveAppPromptInput 返回结构升级（TDD）

**文件：**
- 修改：`src/tui/slash-commands.ts:375-399`
- 测试：现有 resolveAppPromptInput 测试（位置先核实）+ 新断言

**决策：直接改签名**，不留兼容 wrapper——生产调用方只有 `main.ts:850` 一处，wrapper 只会让下一个 workflow 忘记透传 requiredTools。

- [ ] **步骤 1：编写失败的测试**

```typescript
it('workflow 命令透传 requiredTools', () => {
  const r = resolveAppPromptInput('/council 审查方案', '/tmp')
  assert.ok(r && typeof r !== 'string')
  assert.deepEqual(r.requiredTools, ['council_convene', 'team_orchestrate'])
})

it('普通文本与非 workflow slash 返回 requiredTools 为空', () => {
  const r = resolveAppPromptInput('plain prompt', '/tmp')
  assert.equal(r?.requiredTools, undefined)
  assert.equal(r?.prompt, 'plain prompt')
})

it('未知 slash 仍返回 null', () => {
  assert.equal(resolveAppPromptInput('/nonexistent', '/tmp'), null)
})
```

- [ ] **步骤 2：实现**

```typescript
export interface ResolvedPromptInput {
  prompt: string
  /** 见 WorkflowResolveResult.requiredTools。仅 ecosystem workflow 路径可能非空。 */
  requiredTools?: readonly string[]
}

export function resolveAppPromptInput(input: string, cwd: string): ResolvedPromptInput | null {
  if (!input.startsWith('/')) return { prompt: input }
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return { prompt: workflow.prompt, requiredTools: workflow.requiredTools }
  const custom = resolveCustomCommand(cwd, input)
  if (custom) return { prompt: custom }
  // ...其余分支包一层 { prompt }
}
```

- [ ] **步骤 3：验证 + 提交**

```bash
npx tsc --noEmit  # 会揪出 main.ts 调用点（任务 3 一起改，或本任务先行适配保持可编译）
```

提交与任务 3 合并（签名变更与调用方适配须原子）。

---

## 任务 3：main.ts 提交路径自动挂载 + 播报（TDD 受限，以类型 + 手动冒烟为主）

**文件：**
- 修改：`src/main.ts:844-865`（onSubmit）

- [ ] **步骤 1：实现**

```typescript
const resolved = resolveAppPromptInput(trimmed, process.cwd())
if (resolved === null) {
  app!.rejectSubmit()
  app!.commitStatic(`⚠️  Unknown command: ${trimmed.split(/\s/)[0]}\nType /help for available commands.`)
  return
}

// workflow 声明的 EXTENDED 工具在发 run 前挂载——prompt 契约与工具可见性同源。
for (const toolName of resolved.requiredTools ?? []) {
  const mount = ctx!.agent.enableTool(toolName)
  if (mount.status === 'mounted') {
    const costNote = mount.cacheImpact === 'prefix-invalidated'
      ? '（下一请求前缀缓存一次性 MISS，后续轮次按新工具集重新缓存）'
      : ''
    app!.commitStatic(`🔧 已为本次 workflow 挂载工具 ${toolName}${costNote}`)
  }
  // already-active / gating-off → 静默（工具本就可见）
  // unknown / not-extended → 不应发生（requiredTools 与 EXTENDED_TOOLS 的一致性由任务 4 测试钉住）
}

const callbacks = wrapCallbacksWithTuiApp(app!)
ctx!.agent.run(resolved.prompt, callbacks).catch(/* 原样 */)
```

- [ ] **步骤 2：一致性守护测试**（防止未来 workflow 声明拼错工具名或声明了 CORE 工具）

在 `ecosystem-workflows.test.ts` 追加：

```typescript
import { isExtendedTool } from '../../agent/tool-tiers.js'

it('所有 workflow 声明的 requiredTools 必须真实存在于 EXTENDED 层', () => {
  for (const input of ['/council 审查', '/team plan.md', '/team max 重构']) {
    const r = resolveEcosystemWorkflowInput(input)
    for (const t of r?.requiredTools ?? []) {
      assert.ok(isExtendedTool(t), `${input} 声明的 ${t} 不在 EXTENDED_TOOLS——要么拼错要么该工具已改层`)
    }
  }
})
```

- [ ] **步骤 3：验证**

```bash
npx tsc --noEmit
node --import tsx --test-force-exit --test src/workflows/__tests__/ecosystem-workflows.test.ts
npm run build
```

手动冒烟（关键验收，对应会话 5158719d 的失效路径）：
1. TUI 启动（门控默认开）→ `/council 审查这个仓库的 README 结构`
2. 期望看到 `🔧 已为本次 workflow 挂载工具 council_convene...` 播报
3. 期望模型**直接调用 council_convene**（TUI 工具卡片可见），不再出现「grep 源码找工具 → delegate_batch 模拟」
4. `/tools`（如有列表命令）或再次 `/council` 确认 already-active 幂等静默

- [ ] **步骤 4：提交** `fix(tui): auto-mount EXTENDED tools declared by workflow before run (/council, /team)`

---

## 整体验证

- [ ] `npx tsc --noEmit` + `npm run build`
- [ ] 定向测试：`ecosystem-workflows.test.ts` + slash-commands 相关测试 + `tool-gating-escape-hatch.test.ts`（enableTool 无回归）
- [ ] 手动冒烟见任务 3

## 被否决的备选（记录理由）

- **把 council_convene 挪回 CORE**：违背 2026-07-01 分层收敛的初衷（主控视野压到 ~25 降低选择瘫痪），且 /team 还得再挪 team_orchestrate，层就名存实亡。
- **只改 prompt（指示模型先 delegate 或声明工具不可用）**：模型侧兜底不可靠（本会话就是模型自由发挥模拟了议事会），且 delegate 一层白白引入 210s 超时路径。
- **在 AgentLoop.run 内嗅探 prompt 关键词挂载**：把 workflow 语义泄漏进 loop 层；解析结果声明 + 调用方挂载的边界更干净。

## 明确不做（防扩散）

- 桌面聊天输入的 slash workflow 解析（独立特性缺口，桌面议事会走专用 council 路由不受本 bug 影响）
- run 结束后自动卸载挂载的工具（enableTool 本就是会话级语义，卸载反而再吃一次缓存 MISS）
- 其他 EXTENDED 工具的 workflow 化（按需再声明）
