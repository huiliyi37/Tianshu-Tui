# Dead-end 信息素噪音链修复 + maxTurns 放宽 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除会话 `5158719d` 暴露的「天权方向提示」噪音链——bash target 被 50 字符截断成 `cd <repo> && ` 万能前缀 → 超时被当成语义失败沉积 dead-end 信息素 → 双向子串匹配让每条 bash 都命中提示。同时把 `maxTurns` 默认从 50 放宽到 200，让长任务不再需要用户手动「继续」。

**架构：** 修复分四层递进——①target 提取（剥 cd 样板再截断，四处调用点共享 helper）；②errorClass 管道（补 loop-factory 丢参 bug + 新增 `'timeout'` 类目）；③dead-end 沉积收紧（同 target 重复失败 + 排除 timeout/environment + 当前工具须失败）；④匹配端加固（共享 normalize，历史脏数据自然失效，无需迁移存量信息素）。maxTurns 是独立第五任务，只动 schema 默认值。

**技术栈：** TypeScript strict / node:test + node:assert/strict / 无新依赖。

---

## 前置事实（已核实，2026-07-02）

- **50 字符截断四处**（逐字相同的三元链）：
  - `src/agent/tool-history-recorder.ts:23-29`（写入 `recentToolHistory`，dead-end 沉积的数据源）
  - `src/agent/tool-execution.ts:509-516`（postTool hook 的 `tool.target`，stigmergy 沉积用的 path）
  - `src/agent/turn-harness.ts:80-86`（trajectory 记录）
  - `src/agent/tool-pipeline.ts:326-331` `toolTargetFromInput`（TaskLedger 等）
- **existing bug：errorClass 在 loop-factory 被丢弃。** `tool-pipeline.ts:1162` 传 5 参 → `tool-execution.ts:213-214` 正确转发 → **`loop-factory.ts:231` 的 lambda 只接 4 参**，`errorClass` 静默丢失 → `tool-history-recorder.ts:22` 的 environment 免疫中和从未生效。
- **timeout 分类现状**：`bash.ts:393` 超时置 `exitCode=-1`；`classifyBashOutcome`（`bash.ts:98`）把 -1 归入 `'exec-failure'`——超时与真正的执行失败不可区分。exitCode -1 **只有**超时一条产生路径（`isTimeout ? -1 : code`），可作为 timeout 的确定性判据。
- **dead-end 沉积条件过松**（`src/agent/hooks/stigmergy-hook.ts:54-61`）：5 条窗口内任意 2 条 bash failed（不看 target 是否相同、不看失败类别）→ 以**当前** bash 的 target 沉积 strength 0.9 的 dead-end。当前 bash 即使成功也沉积。
- **匹配端双向子串**两处：
  - `src/agent/intent-preview.ts:103-107` `extracted.includes(t) || t.includes(extracted)`（天权 UI 提示）
  - `src/agent/hooks/signal-consumer-hook.ts:69-77` `p.path.includes(rt) || rt.includes(p.path)`（注入模型上下文的 `<天枢-观测>`，噪音同样污染模型）
- **maxTurns 链路**：schema 默认 `src/config/schema.ts:174`（50）→ `bootstrap.ts:942` `config.agent.maxTurns` → AgentLoop。max-turns 停止不自动续跑（`stop-reason.ts:57` 测试确认 `stopReasonAbortTag` 返回 undefined，这是有意语义，不改）。headless 非 goal 模式的 15 轮上限（`main.ts:213`）与 worker 预算（`work-order.ts:300/348`）是独立预算体系，**不在本计划范围**。
- 信息素存量脏数据：会话已沉积的 `cd /Users/banxia/app/deepseek-tui/opencode-tui && ` dead-end 存在 `pheromones.json`，7 天半衰期。修复采取「匹配端 normalize 后为空 → 永不命中」策略消毒，不做存储迁移。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/tool-target.ts` | 创建 | `bashCommandTarget()`：剥 cd 样板 + 截断，四处唯一语义来源 |
| `src/agent/__tests__/tool-target.test.ts` | 创建 | helper 单元测试 |
| `src/agent/tool-history-recorder.ts` | 修改 | 用 helper；`ToolHistoryEntry` 写入 `errorClass` |
| `src/agent/tool-execution.ts` | 修改 | 用 helper（postTool target） |
| `src/agent/turn-harness.ts` | 修改 | 用 helper |
| `src/agent/tool-pipeline.ts` | 修改 | 用 helper（`toolTargetFromInput`） |
| `src/agent/loop-factory.ts` | 修改 | 修 errorClass 丢参（1 行） |
| `src/tools/bash.ts` | 修改 | `classifyBashOutcome` 增加 `'timeout'` 类目 |
| `src/tools/types.ts` | 修改 | `ToolResult.errorClass` union 补 `'timeout'` |
| `src/prompt/volatile.ts` | 修改 | `ToolHistoryEntry` 增加 `errorClass?` 字段 |
| `src/agent/runtime-hooks.ts` | 修改 | snapshot 的 Pick 列表补 `'errorClass'` |
| `src/agent/hooks/stigmergy-hook.ts` | 修改 | dead-end 沉积三重收紧 |
| `src/agent/dead-end-match.ts` | 创建 | `normalizeDeadEndTarget()` + `matchesDeadEnd()`，两个消费端共享 |
| `src/agent/intent-preview.ts` | 修改 | 委托共享匹配 |
| `src/agent/hooks/signal-consumer-hook.ts` | 修改 | 委托共享匹配 |
| `src/config/schema.ts` | 修改 | `maxTurns` 默认 50 → 200 |

**任务依赖**：任务 1（target）与任务 2（errorClass）独立可并行；任务 3（沉积）依赖 1+2；任务 4（匹配）独立可并行；任务 5（maxTurns）完全独立。

---

## 任务 1：共享 bash target 提取 helper（TDD）

**文件：**
- 创建：`src/agent/tool-target.ts`
- 测试：`src/agent/__tests__/tool-target.test.ts`
- 修改：上表四处调用点

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bashCommandTarget, toolTargetFromInput } from '../tool-target.js'

describe('bashCommandTarget', () => {
  it('剥离 cd <path> && 样板后再截断——根因场景', () => {
    const cmd = 'cd /Users/banxia/app/deepseek-tui/opencode-tui && npx tsc --noEmit'
    assert.equal(bashCommandTarget(cmd), 'npx tsc --noEmit')
  })

  it('剥离带引号路径的 cd 样板', () => {
    assert.equal(bashCommandTarget('cd "/path with spaces/repo" && npm test'), 'npm test')
    assert.equal(bashCommandTarget("cd '/tmp/x' && ls"), 'ls')
  })

  it('连续多个 cd 段全部剥离', () => {
    assert.equal(bashCommandTarget('cd /a && cd /b && make'), 'make')
  })

  it('纯 cd 命令（无后续段）原样保留——cd 本身就是目标', () => {
    assert.equal(bashCommandTarget('cd /some/dir'), 'cd /some/dir')
  })

  it('剥离后仍超 50 字符则截断到 50', () => {
    const long = 'cd /repo && ' + 'x'.repeat(80)
    assert.equal(bashCommandTarget(long).length, 50)
    assert.equal(bashCommandTarget(long), 'x'.repeat(50))
  })

  it('无 cd 前缀的命令行为不变（纯截断）', () => {
    assert.equal(bashCommandTarget('npm run build'), 'npm run build')
    assert.equal(bashCommandTarget('y'.repeat(80)), 'y'.repeat(50))
  })
})

describe('toolTargetFromInput', () => {
  it('file_path > path > command 优先级保持', () => {
    assert.equal(toolTargetFromInput('edit_file', { file_path: 'a.ts', command: 'x' }), 'a.ts')
    assert.equal(toolTargetFromInput('grep', { path: 'src/' }), 'src/')
    assert.equal(toolTargetFromInput('bash', { command: 'cd /repo && npm test' }), 'npm test')
    assert.equal(toolTargetFromInput('todo', {}), 'todo')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
node --import tsx --test-force-exit --test src/agent/__tests__/tool-target.test.ts
```

- [ ] **步骤 3：实现 `src/agent/tool-target.ts`**

```typescript
/** 匹配开头的 `cd <path> && `（path 可带单/双引号），可重复出现。 */
const CD_BOILERPLATE_RE = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/

const TARGET_MAX_CHARS = 50

/**
 * 从 bash 命令提取历史/信息素/轨迹用的 target。
 *
 * 会话 5158719d 根因：`command.slice(0, 50)` 对本仓库几乎所有命令截出
 * 同一个 `cd <repo-path> && ` 前缀 → dead-end 信息素 target 失去区分度 →
 * 双向子串匹配全命中 → 天权提示每条 bash 都响。先剥 cd 样板再截断，
 * target 恢复「这条命令实际做什么」的语义。
 */
export function bashCommandTarget(command: string): string {
  let rest = command
  while (CD_BOILERPLATE_RE.test(rest)) {
    const stripped = rest.replace(CD_BOILERPLATE_RE, '')
    if (stripped.trim() === '') break // 纯 cd：cd 本身就是目标，保留
    rest = stripped
  }
  return rest.trim().slice(0, TARGET_MAX_CHARS)
}

/** file_path > path > command 的统一 target 提取（原 4 处逐字重复的三元链）。 */
export function toolTargetFromInput(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.command === 'string') return bashCommandTarget(input.command)
  return toolName
}
```

- [ ] **步骤 4：替换四处调用点**
  - `tool-history-recorder.ts:23-29` → `toolTargetFromInput(name, input)`（注意原实现 `path` 优先于 `file_path`，统一后以 `file_path` 优先——两字段同时出现的工具不存在，行为等价）
  - `tool-execution.ts:509-516` → `toolTargetFromInput(tu.name, tu.input)`（原缺省返回 `undefined`，这里保持：`typeof tu.input?.command === 'string' || ... ? toolTargetFromInput(...) : undefined`，或给 helper 加 `fallback` 参数——实现时取更简洁者，语义不变即可）
  - `turn-harness.ts:80-86` → 同上
  - `tool-pipeline.ts:326-331` → 删除本地 `toolTargetFromInput`，import 共享版

- [ ] **步骤 5：运行测试与回归**

```bash
node --import tsx --test-force-exit --test src/agent/__tests__/tool-target.test.ts
npx tsc --noEmit
node --import tsx --test-force-exit --test src/agent/__tests__/tool-pipeline.test.ts src/agent/__tests__/intent-preview.test.ts
```

- [ ] **步骤 6：提交** `fix(agent): strip cd boilerplate from bash tool targets (shared helper)`

---

## 任务 2：errorClass 管道修复 + timeout 类目（TDD）

**文件：**
- 修改：`src/tools/bash.ts`、`src/tools/types.ts`、`src/agent/loop-factory.ts`、`src/agent/loop.ts`、`src/agent/tool-pipeline.ts`（签名）、`src/agent/tool-execution.ts`（签名）、`src/agent/tool-history-recorder.ts`、`src/prompt/volatile.ts`、`src/agent/runtime-hooks.ts`
- 测试：`src/tools/__tests__/bash.test.ts`（追加）、`src/agent/__tests__/tool-pipeline.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

`bash.test.ts` 追加：

```typescript
it('timeout (exit=-1) → timeout 类，不再与 exec-failure 混同', () => {
  const r = classifyBashOutcome(-1, '', false)
  assert.equal(r.isError, true)
  assert.equal(r.errorClass, 'timeout')
  // Windows 路径同样
  assert.equal(classifyBashOutcome(-1, '', true).errorClass, 'timeout')
})
```

`tool-pipeline.test.ts` 追加（针对 loop-factory 丢参 bug 的防回归——直接测 recordToolHistory 链能收到 errorClass 并写入 entry）：

```typescript
it('recordToolHistory 把 errorClass 写入 recentToolHistory entry（loop-factory 丢参防回归）', () => {
  // 构造 AgentLoop（沿用本文件现有 makeAgent/makeLoop 工装），
  // 调 agent.recordToolHistory('bash', { command: 'sleep 99' }, true, '[timeout]', 'timeout')
  // 断言 agent.recentToolHistory.at(-1).errorClass === 'timeout'
})
```

- [ ] **步骤 2：类型扩展**
  - `src/tools/types.ts:216`：`errorClass?: 'environment' | 'exec-failure' | 'timeout'`——建议提取 `export type ToolErrorClass = 'environment' | 'exec-failure' | 'timeout'` 供各签名复用
  - 波及签名（全部改为引用 `ToolErrorClass`）：`tool-pipeline.ts:226`、`tool-execution.ts:213`、`loop.ts:629`、`tool-history-recorder.ts:16`

- [ ] **步骤 3：实现**
  - `bash.ts` `classifyBashOutcome` 开头加：`if (exitCode === -1) return { isError: true, errorClass: 'timeout' }`（exit=-1 是超时的唯一产生路径，先于 Windows/POSIX 分支判断）
  - `loop-factory.ts:231` 修丢参：`recordToolHistory: (name, input, isError, content, errorClass) => self.recordToolHistory(name, input, isError, content, errorClass)`
  - `volatile.ts` `ToolHistoryEntry` 加 `errorClass?: ToolErrorClass`；`tool-history-recorder.ts:35-41` 写入 entry
  - `runtime-hooks.ts:29` Pick 列表加 `'errorClass'`
  - 注意：`tool-history-recorder.ts:22` 的 immune 中和**保持只对 `'environment'`**——timeout 是否影响 immune 是另一个语义决策，本计划不动

- [ ] **步骤 4：验证**

```bash
npx tsc --noEmit
node --import tsx --test-force-exit --test src/tools/__tests__/bash.test.ts src/agent/__tests__/tool-pipeline.test.ts
```

- [ ] **步骤 5：提交** `fix(agent): thread bash errorClass through loop-factory; classify timeout distinctly`

---

## 任务 3：dead-end 沉积三重收紧（TDD，依赖任务 1+2）

**文件：**
- 修改：`src/agent/hooks/stigmergy-hook.ts`
- 测试：`src/agent/__tests__/stigmergy-hook.test.ts`（如无则创建；先 `ls src/agent/__tests__/ | grep stigmergy` 确认）

**收紧语义**（三个条件全部满足才沉积 dead-end）：
1. **当前 bash 失败**（`tool.success === false`）——现状是成功的 bash 也会因窗口内旧失败而沉积；
2. **同 target 重复**：窗口内 `tool === 'bash' && status === 'failed' && target === tool.target` 的条目 ≥ 2（含当前条；任务 1 后 target 有区分度，这个条件才有意义）；
3. **排除非语义失败**：`errorClass` 为 `'timeout'` 或 `'environment'` 的条目不计入——超时 ≠ 死路（命令可能只是慢），环境缺命令 ≠ 死路。

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStigmergyRuntimeHook } from '../hooks/stigmergy-hook.js'
// 工装：构造 deps（deposit 收集到数组）+ ctx（snapshot.recentToolHistory 可注入）+ tool payload

describe('stigmergy dead-end 沉积收紧', () => {
  it('同 target 的 bash 语义失败 ≥2 且当前失败 → 沉积 dead-end', async () => {
    // history: 2× { tool:'bash', status:'failed', target:'npx tsc --noEmit' }
    // tool: { name:'bash', success:false, target:'npx tsc --noEmit' }
    // 期望 deposits 含 { path:'npx tsc --noEmit', signal:'dead-end' }
  })

  it('当前 bash 成功 → 不沉积（旧行为回归缺陷）', async () => {
    // history 同上 2× failed，tool.success = true → 无 dead-end
  })

  it('不同 target 的失败不累计', async () => {
    // history: failed@'npm test' + failed@'npx tsc --noEmit'，current failed@'ls'
    // → 无 dead-end
  })

  it('timeout / environment 类失败不计入死路', async () => {
    // history: 2× { status:'failed', target:'npx tsc --noEmit', errorClass:'timeout' }
    // current: failed@same target（errorClass:'timeout'）→ 无 dead-end
  })
})
```

- [ ] **步骤 2：实现**（`stigmergy-hook.ts:54-61` 替换）

```typescript
if (tool.name === 'bash' && !tool.success && tool.target) {
  const semanticFailures = ctx.snapshot.recentToolHistory.filter(
    h => h.tool === 'bash'
      && h.status === 'failed'
      && h.target === tool.target
      && h.errorClass !== 'timeout'
      && h.errorClass !== 'environment',
  ).length
  if (semanticFailures >= 2) {
    deposits.push({ path: tool.target, signal: 'dead-end', strength: 0.9 })
  }
}
```

注意：当前工具自身的失败类别经 `tool.failureClass`（`RuntimeHookToolPayload`，由 `classifyFailure` 得出）可用——若 `tool.failureClass === 'timeout'` 同样跳过沉积（双保险，覆盖当前条尚未入窗口的时序）。

- [ ] **步骤 3：验证 + 提交**

```bash
npx tsc --noEmit && node --import tsx --test-force-exit --test src/agent/__tests__/stigmergy-hook.test.ts
```

提交：`fix(agent): tighten dead-end pheromone deposit (same-target, semantic failures, current must fail)`

---

## 任务 4：dead-end 匹配端共享 normalize（TDD，可与 1-3 并行）

**文件：**
- 创建：`src/agent/dead-end-match.ts` + `src/agent/__tests__/dead-end-match.test.ts`
- 修改：`src/agent/intent-preview.ts`（`extractDeadEndPath`/`relevantDeadEnds` 委托）、`src/agent/hooks/signal-consumer-hook.ts:69-77`
- 回归：`src/agent/__tests__/intent-preview.test.ts` 现有用例（含 legacy `处理 xxx...` 前缀剥离）必须全绿

**共享语义**：
- `normalizeDeadEndTarget(path)`：剥 `处理 ` 摘要前缀与 `...` 截断尾（迁移自 `extractDeadEndPath`）→ 剥 cd 样板（复用任务 1 的 `bashCommandTarget` 逻辑，**若剥完为空则返回 ''**，不做「纯 cd 保留」——匹配端语义是消毒）→ trim。
- `matchesDeadEnd(deadEndPath, targets)`：normalize 后长度 < 5 → 永不匹配（消毒存量 `cd <repo> && ` 脏数据 + 防短碎片误命中）；否则保持双向子串（`extracted.includes(t) || t.includes(extracted)`），t 侧同样跳过 `<` 开头的占位 target。

- [ ] **步骤 1：编写失败的测试**

```typescript
describe('normalizeDeadEndTarget', () => {
  it('存量脏数据 cd <repo> &&（截断尾）→ 空串，永不匹配', () => {
    assert.equal(normalizeDeadEndTarget('cd /Users/banxia/app/deepseek-tui/opencode-tui && '), '')
  })
  it('legacy 摘要前缀 处理 xxx... → 剥离', () => {
    assert.equal(normalizeDeadEndTarget('处理 src/legacy/mod...'), 'src/legacy/mod')
  })
  it('新格式带 cd 样板 → 剥出实际命令', () => {
    assert.equal(normalizeDeadEndTarget('cd /repo && npx tsc --noEmit'), 'npx tsc --noEmit')
  })
})

describe('matchesDeadEnd', () => {
  it('normalize 后 <5 字符 → 不匹配（短碎片消毒）', () => {
    assert.equal(matchesDeadEnd('ls', ['ls -la /src']), false)
  })
  it('有意义 target 双向子串仍工作', () => {
    assert.equal(matchesDeadEnd('npx tsc --noEmit', ['cd /repo && npx tsc --noEmit --watch'.slice(0, 50)]), true)
  })
  it('占位 target（<pending> 等）跳过', () => {
    assert.equal(matchesDeadEnd('npx tsc --noEmit', ['<pending>']), false)
  })
})
```

- [ ] **步骤 2：实现 + 两个消费端委托**
  - `intent-preview.ts` `relevantDeadEnds` P0 路径改为 `matchesDeadEnd(de.path, targets)`；`extractDeadEndPath` 逻辑并入 `normalizeDeadEndTarget`（保留 `继续执行当前计划` 的永不关联守卫）
  - `signal-consumer-hook.ts:71-77` 的手写双向 includes 替换为 `matchesDeadEnd(p.path, recentTargets)`
  - **注意 targets 侧也 normalize**：recentTargets 里的 bash 条目在任务 1 之后已经是剥过样板的，无需二次处理；但为兼容旧会话恢复（历史 entry 未剥），matchesDeadEnd 内部对 target 侧也过一遍 normalize 更稳

- [ ] **步骤 3：验证 + 提交**

```bash
npx tsc --noEmit
node --import tsx --test-force-exit --test src/agent/__tests__/dead-end-match.test.ts src/agent/__tests__/intent-preview.test.ts src/agent/__tests__/signal-consumer-hook.test.ts
```

提交：`fix(agent): shared dead-end matching with boilerplate normalization (sanitizes legacy pheromones)`

---

## 任务 5：maxTurns 默认 50 → 200（独立）

**文件：**
- 修改：`src/config/schema.ts:174`
- 回归：`src/config/__tests__/` 下若有断言默认值 50 的用例同步更新（先 `rg 'maxTurns' src/config/__tests__ src/__tests__` 核实；`create-agent-config.test.ts:27` 是显式传值，不受影响）

**决策依据**（写进 schema 注释）：
- 会话 5158719d 两次撞 50 上限被迫人工「继续」——对天枢定位的长任务（重构/多文件交付）50 轮明显不够，用户判断 100 轮也没问题。
- runaway 防护已由四层独立守护承担：wedged-loop（同失败批次 3 次）、convergence detector、watchdog（含 session-total 12 次配额）、context pressure/压缩。maxTurns 只是最后的远端兜底，对标 Claude Code / Codex（无硬轮次上限）取 200——4 倍余量，正常任务永远撞不到，真 runaway 时其他守护先触发。
- **不放宽的**：headless 非 goal 15 轮（`main.ts:213`，一次性脚本场景故意紧）、worker 预算 8/14 轮（`work-order.ts`，委派单元故意小）、`maxAutoContinue`（0-3 clamp，语义不同）。

- [ ] **步骤 1：改 schema 默认值 + 注释**

```typescript
// 长任务远端兜底。runaway 由 wedged-loop/convergence/watchdog/context-pressure
// 先行拦截，此值对标 Claude Code/Codex 的"无硬上限"取宽松 4 倍余量（50→200，
// 会话 5158719d 证明 50 轮迫使用户在正常长任务中反复手动「继续」）。
maxTurns: z.number().int().positive().default(200),
```

- [ ] **步骤 2：验证 + 提交**

```bash
npx tsc --noEmit
node --import tsx --test-force-exit --test src/config/__tests__/*.test.ts src/__tests__/create-agent-config.test.ts
```

提交：`feat(config): raise default maxTurns 50→200 for long-running tasks`

---

## 整体验证

- [ ] `npx tsc --noEmit`
- [ ] 定向：本计划新增/修改的全部测试文件
- [ ] 邻接回归：`node --import tsx --test-force-exit --test src/agent/__tests__/tool-pipeline.test.ts src/agent/__tests__/loop.test.ts src/agent/__tests__/intent-preview.test.ts`
- [ ] 手动冒烟：TUI 会话里连续跑 3 条带 `cd <repo> &&` 前缀的失败 bash（如 `cd <repo> && exit 1`）→ 确认不再出现「天权 · 方向提示（cd ... &&）」；跑一条 `timeout 1 sleep 5` 类超时命令 ×2 → 确认无 dead-end 沉积（查 `~/.rivet/sessions/<slug>/<id>/pheromones.json`）

## 明确不做（防扩散）

- 不迁移/清洗存量 `pheromones.json`（匹配端消毒已覆盖，7 天半衰期自然淘汰）
- 不改 immune/momentum 对 timeout 的处理（独立语义决策）
- 不改 bash 默认 120s 超时或模型传 30s timeout 的行为（模型侧选择）
- 不改 max-turns 停止的「不自动续跑」语义（有意护栏：上限撞到时应让用户看一眼）
- `/council` 工具门控错配是独立计划：`2026-07-02-council-extended-tool-mount.md`
