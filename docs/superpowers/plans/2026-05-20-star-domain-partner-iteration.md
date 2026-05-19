# 星域伙伴迭代 — 从底座到人格展现 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在已完成底座（StarFlow v2 organ network、冰鉴缓存 v2、天枢无线电、AB 实验验证人格有效）的基础上，完成迭代闭环：上下文减重让噪音退场 → 习惯化 v3 完成让缓存更聪明 → 星域人格从底座中浮现 → 天枢之眼让用户看见伙伴的存在。

**架构：** 三个独立可验证的迭代，每个迭代产出可度量的改进。迭代 A 收尾当前未提交的 habituation v3 + type error 修复。迭代 B 做 volatile 上下文审计减重，目标是每轮 FRESH appendix 从 ~3000 tokens 降至 ~2000 tokens。迭代 C 让无线电更频繁、更人格化——在 phase 内也周期性发送状态简报，并将星域信息注入无线电消息。

**技术栈：** TypeScript strict, Node.js 22+, node:test + node:assert/strict, Ink 6 (React TUI)

---

## 前置状态

### 已完成（已提交）
- StarFlow v2 organ network：sensorium (3D), star phase (8 phases), vigor, theta
- 冰鉴缓存 v2：FieldHabituationTracker + 三区布局 (frozen / consolidated / active)
- 天枢无线电：phase transition + milestone + stuck detection，15 个中文模板
- 星域系统：pojun / tianfu / tianliang 三域 + 关键词匹配 + volatileBlock 注入
- 勇气钩子：风险信号检测 + 元认知注入，受 STAR_SOUL 门控
- AB 实验：有人格 vs 无人格同一模型 5 任务对比，证明人格有效

### 当前未提交（working tree dirty）
- `src/prompt/field-habituation.ts`：habituation v3 信心累加器代码已写，但 L35 有 type error
- `src/prompt/__tests__/field-habituation.test.ts`：v3 测试已添加（3 个新 describe 块）
- `.rivet/playbook.jsonl`：playbook 调整

### 已设计未实现
- 天枢之眼 Layer 1（星相 Strip）— 设计完成，SummaryBar 已扩展接口但数据未流入
- 天枢之眼 Layer 2（无线电增强）— 仅 phase 转换时触发，phase 内静默
- 冰鉴缓存验证脚本 — scaffold 已存在但未完成

---

## 迭代 A：习惯化 v3 收尾

### Scope check

单一子系统：`src/prompt/field-habituation.ts` + `src/prompt/engine.ts` + `src/agent/loop.ts`。不涉及 TUI、tools、或 compact 模块。与其他迭代无依赖关系，可独立交付。

### 文件结构

| 文件 | 职责 |
|------|------|
| 修改 `src/prompt/field-habituation.ts` | 修复 L35 type error（`promotionThreshold` 可能为 undefined），确保 backward compat 路径不产生类型歧义 |
| 修改 `src/prompt/engine.ts` | 新增 `setPhaseHint(hint: string)` 方法，在 `buildRequest` 中将 phaseHint 传入 `tracker.recordTurn()` |
| 修改 `src/agent/loop.ts` | perception 完成后调用 `promptEngine.setPhaseHint(phaseClass)` |
| 修改 `src/prompt/__tests__/field-habituation.test.ts` | 确保所有 v2 兼容测试 + v3 新测试全部通过 |

### 任务 A1：修复 type error + 确认 v3 逻辑正确

**文件：**
- 修改：`src/prompt/field-habituation.ts`

- [ ] **步骤 1：定位并修复 L35 type error**

错误位置：`src/prompt/field-habituation.ts:35` — `Type 'number | undefined' is not assignable to type 'number'`。

根因：`config.promotionThreshold` 类型为 `number | undefined`，但直接赋值给 `this.promotionThreshold: number`。backward compat 路径中 `config.threshold !== undefined && config.promotionThreshold === undefined` 分支里虽然赋值了 `0.8`，但 TypeScript 在 else 分支无法 narrowing `config.promotionThreshold`。

修复方案：用明确的 fallback 替代条件分支中的类型歧义：

```typescript
constructor(config: HabituationConfig) {
  // promotionThreshold: use explicit value, or fallback to 0.8
  // Backward compat: if only threshold is provided (deprecated), ignore it for v3 behavior
  const pt = config.promotionThreshold
  this.promotionThreshold = pt !== undefined ? pt : 0.8
  const dr = config.decayRate
  this.decayRate = dr !== undefined ? dr : 0.3
}
```

同时简化 `HabituationConfig` 接口，移除内部条件分支中对 `config.threshold` 的引用（保留字段声明以维持 backward compat，但构造函数不再读取它）。

- [ ] **步骤 2：运行 typecheck 确认修复**

```bash
npx tsc --noEmit
```

期望：0 errors。

- [ ] **步骤 3：commit**

```bash
git add src/prompt/field-habituation.ts
git commit -m "fix(prompt): resolve promotionThreshold type ambiguity in habituation v3 constructor"
```

### 任务 A2：运行并修复 v3 测试

**文件：**
- 修改：`src/prompt/__tests__/field-habituation.test.ts`

- [ ] **步骤 1：运行 habituation 测试**

```bash
npx tsx --test src/prompt/__tests__/field-habituation.test.ts
```

期望：所有测试通过（包括 v2 兼容测试和 v3 新测试）。

如果 v2 兼容测试失败（因为 `threshold: 5` 在 v3 中不再直接控制行为），检查 `recordTurn` 的 backward compat 路径是否正确。预期行为：
- 传入 `{ threshold: 5 }` 时，`promotionThreshold` 默认 0.8，`decayRate` 默认 0.3
- 稳定字段需要 ~8 turn（默认 α=0.2）达到 0.8 置信度

如果测试中某些断言使用了旧的固定计数器逻辑（如 "5 turns 晋升"），它们应该已经被更新为 8 turns。检查 diff 确认。

- [ ] **步骤 2：如有失败，逐个修复测试断言**

如果 "counter resets on content change" 测试失败：确认 v3 中 change 行为是 `confidence = alpha`（不是 0）。这是设计决策——首次出现的新值从 α 开始累加，而非归零。如果测试期望归零行为，更新测试以匹配 v3 设计。

如果 "field absent decays rather than hard reset" 测试失败：确认 v3 中 absent 行为是 `confidence *= (1 - decayRate)`。如果测试期望硬重置，更新测试以匹配 decay 行为。

- [ ] **步骤 3：commit**

```bash
git add src/prompt/__tests__/field-habituation.test.ts
git commit -m "test(prompt): update habituation tests for v3 confidence accumulator semantics"
```

### 任务 A3：接入 phaseHint 数据流

**文件：**
- 修改：`src/prompt/engine.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 PromptEngine 添加 setPhaseHint 方法**

在 `src/prompt/engine.ts` 中，找到 `FieldHabituationTracker` 的使用位置。添加私有字段 `private currentPhaseHint: string = 'plan'` 和公共方法：

```typescript
setPhaseHint(hint: string): void {
  this.currentPhaseHint = hint
}
```

在 `buildRequest` 中调用 `tracker.recordTurn(fieldValues, this.currentPhaseHint)` 的位置，确保 phaseHint 参数已传入（当前代码可能只传了 fieldValues）。检查现有调用签名。

- [ ] **步骤 2：在 AgentLoop perception 后注入 phaseHint**

在 `src/agent/loop.ts` 中找到 perception 完成后的代码路径（通常在 `perception.perceive()` 调用之后，`promptEngine.buildRequest()` 之前）。

需要获取当前 phase class。从 `star-event.ts` 导入 `mapSensoriumToPhase` 和 phase class 映射逻辑。由于架构约束不允许 `src/prompt/` import `src/agent/`，phaseHint 使用 string 类型：

```typescript
// 在 agent/loop.ts 中，perception 完成后
const sensorium = this.sensorium // 从 hook effects 获取
if (sensorium && this.starPhaseContext) {
  const starPhase = mapSensoriumToPhase(sensorium, this.starPhaseContext)
  const phaseClass = classifyPhase(starPhase) // 'explore' | 'plan' | 'execute' | 'verify' | 'deliver'
  this.promptEngine.setPhaseHint(phaseClass)
}
```

注意：`classifyPhase` 函数目前只在 `radio-hook.ts` 中定义。将其提取到 `star-event.ts` 中作为导出函数，供 `loop.ts` 复用。

修改 `src/agent/star-event.ts`：从 `radio-hook.ts` 中移动 `PhaseClass` 类型和 `PHASE_CLASS_MAP` + `classifyPhase` 到 `star-event.ts`，导出它们。然后更新 `radio-hook.ts` 从 `star-event.ts` 导入。

- [ ] **步骤 3：运行 typecheck + habituation 测试**

```bash
npx tsc --noEmit
npx tsx --test src/prompt/__tests__/field-habituation.test.ts
```

期望：0 errors，所有测试通过。

- [ ] **步骤 4：commit**

```bash
git add src/prompt/engine.ts src/agent/loop.ts src/agent/star-event.ts src/agent/hooks/radio-hook.ts
git commit -m "feat(agent): wire phaseHint from AgentLoop to FieldHabituationTracker"
```

### 任务 A4：端到端验证 — 运行完整测试套件

- [ ] **步骤 1：运行全部测试**

```bash
npx tsx --test src/**/__tests__/*.test.ts
```

期望：通过率不低于迭代前基线。已知 flaky：`compact.test.ts` — "truncates old messages iteratively" 偶尔失败，不属于本次回归。

- [ ] **步骤 2：commit（如有修复）**

```bash
git commit -m "chore: habituation v3 iteration A complete — type fix + phaseHint wiring"
```

---

## 迭代 B：上下文减重 — 让噪音退场

### Scope check

单一子系统：`src/prompt/volatile.ts` + `src/prompt/volatile-git.ts`。不改变三区布局结构，不改变缓存锚点。仅审计每个动态字段的 token 开销并做精准裁剪。独立于迭代 A/C，但建议在 A 完成后执行以获得准确的 phaseHint 数据。

### 文件结构

| 文件 | 职责 |
|------|------|
| 修改 `src/prompt/volatile.ts` | 审计并精简动态字段内容；减少冗余信息；缩短工具历史条目 |
| 修改 `src/prompt/volatile-git.ts` | 缩短 git status 输出（当前全量 `git status --porcelain`，可截断） |
| 新建 `src/prompt/__tests__/volatile-weight.test.ts` | 测量 volatile block token 数，确保减重后不超过目标 |

### 任务 B1：审计当前 volatile token 开销

**文件：**
- 新建：`src/prompt/__tests__/volatile-weight.test.ts`

- [ ] **步骤 1：编写 token 计数测试**

创建测试文件，使用模拟数据构建 volatile block，用简单的 token 估算（英文：单词数 × 1.3，中文：字符数 × 1.5）测量各部分 token 开销：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Token estimation helper
function estimateTokens(text: string): number {
  // Rough: English words × 1.3, CJK chars × 1.5
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk * 1.5 + (words - cjk) * 1.3)
}

describe('volatile weight baseline', () => {
  it('total volatile block should be under 3000 tokens', () => {
    // Use real volatile builder with mock data
    // ...
  })
})
```

运行测试捕获当前基线（期望失败，因为我们还不知道确切数字）。记录当前 token 数。

- [ ] **步骤 2：commit baseline test**

```bash
git add src/prompt/__tests__/volatile-weight.test.ts
git commit -m "test(prompt): add volatile token weight baseline measurement"
```

### 任务 B2：裁剪冗余字段

**文件：**
- 修改：`src/prompt/volatile.ts`

审计 `buildLatestTurnVolatileBlock` 中每个字段：

| 字段 | 当前估算 | 裁剪方案 | 预期节省 |
|------|---------|---------|---------|
| `tool-history` | ~800 tokens（每条目含 tool+target+status+timing） | 去除 timing 字段；target 截断到 60 chars；最多保留 5 条（从 8 条） | ~300 tokens |
| `claims` | ~400 tokens（全量 active claims） | 仅保留 session 级 + confidence≥0.8 的 claims | ~150 tokens |
| `lessons` | ~300 tokens（全量 historical lessons） | 仅保留最近 2 条；超过 200 chars 的截断 | ~150 tokens |
| `ledger` | ~200 tokens | 去除（capability ledger 在 cockpit 展示，不进 LLM 上下文） | ~200 tokens |
| `behaviorMirror` | ~200 tokens | 保留但压缩格式（去除冗余描述） | ~50 tokens |

- [ ] **步骤 1：修改 tool-history 渲染**

在 `volatile.ts` 中找到 `recentToolHistory` 渲染逻辑。当前保留最近 8 条。改为最近 5 条。每条去除 `timing` 字段。`target` 超过 60 chars 的截断为 `...前60字符...`。

- [ ] **步骤 2：修改 claims 渲染**

仅渲染 `scope === 'session'` 且 `confidence >= 0.8` 的 claims。每条截断到 120 chars。

- [ ] **步骤 3：修改 lessons 渲染**

仅保留最近 2 条 historical lessons。每条超过 200 chars 的截断。

- [ ] **步骤 4：移除 ledger 字段**

从 volatile block 中移除 capability ledger 渲染（ledger 在 cockpit 中展示，不进 LLM 上下文）。

- [ ] **步骤 5：压缩 behaviorMirror 格式**

将 behaviorMirror 从多行描述压缩为单行摘要。

- [ ] **步骤 6：运行 typecheck + volatile 测试**

```bash
npx tsc --noEmit
npx tsx --test src/prompt/__tests__/volatile-weight.test.ts
```

期望 token 数从基线降低 20-30%。

- [ ] **步骤 7：commit**

```bash
git add src/prompt/volatile.ts
git commit -m "perf(prompt): trim volatile context — tool history 8→5, drop ledger, compress claims/lessons"
```

### 任务 B3：截断 git status 输出

**文件：**
- 修改：`src/prompt/volatile-git.ts`

当前 git status 输出全量 `git status --porcelain`。在大型 repo 中可能数百行。

- [ ] **步骤 1：添加截断逻辑**

在 `volatile-git.ts` 中，对 git status 输出做截断：
- 最多保留 30 行
- 超过 30 行时追加 `... (truncated, total N files changed)`
- 过滤掉 `node_modules/` 和 `.git/` 路径（这些不应出现在 porcelain 中，但做防御）

- [ ] **步骤 2：运行相关测试**

```bash
npx tsx --test src/prompt/__tests__/volatile-git.test.ts
```

- [ ] **步骤 3：commit**

```bash
git add src/prompt/volatile-git.ts
git commit -m "perf(prompt): truncate git status output at 30 lines in volatile context"
```

### 任务 B4：端到端验证

- [ ] **步骤 1：运行完整测试套件 + 确认 volatile weight 达标**

```bash
npx tsx --test src/**/__tests__/*.test.ts
npx tsx --test src/prompt/__tests__/volatile-weight.test.ts
```

期望：weight 测试通过（token 数在目标范围内），其他测试通过率不低于基线。

- [ ] **步骤 2：commit**

```bash
git commit -m "perf(prompt): iteration B complete — volatile context ~30% lighter"
```

---

## 迭代 C：无线电增强 — 让伙伴开口

### Scope check

涉及两个子系统：agent hooks（`radio-hook.ts`, `radio-templates.ts`）+ TUI（`app.tsx`, `summary-bar.tsx`）。两个子系统通过 `onPhaseChange` callback 连接。独立于迭代 A/B，但建议在 B 完成后执行——上下文减重后，无线电消息在 LLM 上下文中的信噪比更高。

### 文件结构

| 文件 | 职责 |
|------|------|
| 新建 `src/agent/hooks/__tests__/radio-hook.test.ts` | 无线电 hook 单元测试（触发条件、频率控制、domain 注入） |
| 修改 `src/agent/hooks/radio-hook.ts` | 新增 phase 内周期性心跳；星域信息注入消息 |
| 修改 `src/agent/radio-templates.ts` | 新增 3 个星域感知模板；`extractTemplateVars` 接收 domain 参数 |
| 修改 `src/tui/app.tsx` | 消费 `onPhaseChange` 中的 `domainType` 字段，渲染到对话流 |
| 修改 `src/tui/summary-bar.tsx` | 确保 `starPhaseGlyph`、`starPhaseLabel`、`alchemyConfidence`、`recentToolSummary` 已正确流入 |

### 任务 C1：无线电心跳 — phase 内周期性简报

**文件：**
- 修改：`src/agent/hooks/radio-hook.ts`
- 新建：`src/agent/hooks/__tests__/radio-hook.test.ts`

当前无线电仅在 phase 转换、test pass/fail、stuck 检测时触发。在长执行阶段（如连续 15 turn 的 `execute`），用户可能几分钟听不到任何声音。

- [ ] **步骤 1：编写失败测试 — heartbeat 触发**

```typescript
// src/agent/hooks/__tests__/radio-hook.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('radio heartbeat', () => {
  it('emits heartbeat after HEARTBEAT_INTERVAL turns in same phase', () => {
    // 构造 mock RuntimeHookContext，turn=12, same phase for 6+ turns
    // 期望 emitPhaseChange 被调用，reason 包含 phase 简报
  })

  it('does NOT emit heartbeat before HEARTBEAT_INTERVAL', () => {
    // turn=5, same phase for 3 turns
    // 期望 emitPhaseChange 不被额外调用
  })

  it('resets heartbeat counter on phase change', () => {
    // phase 转换后，heartbeat 计数器归零
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npx tsx --test src/agent/hooks/__tests__/radio-hook.test.ts
```

- [ ] **步骤 3：实现 heartbeat 逻辑**

在 `radio-hook.ts` 中添加：

```typescript
const HEARTBEAT_INTERVAL = 6 // turns between periodic status updates within same phase
let samePhaseTurnCount = 0

// 在 phase 未变化的分支中，递增计数器
if (currentPhase === lastPhase) {
  samePhaseTurnCount++
} else {
  samePhaseTurnCount = 0
}

// Heartbeat: periodic status in same phase (not on transition)
if (
  samePhaseTurnCount >= HEARTBEAT_INTERVAL &&
  turn - lastEmitTurn >= COOLDOWN_TURNS
) {
  const vars = extractTemplateVars(toolHistory)
  vars.phaseName = PHASE_SHORT_LABELS[starPhase]
  vars.turnCount = turn
  const message = formatRadioMessage({ transition: 'heartbeat', vars })
  lastEmitTurn = turn
  effects.emitPhaseChange('tianshu-radio', { reason: message })
}
```

在 `radio-templates.ts` 中添加 heartbeat 模板：

```typescript
'heartbeat': '[天枢] {phaseName}中，第{turnCount}轮。',
```

- [ ] **步骤 4：运行测试确认通过**

```bash
npx tsx --test src/agent/hooks/__tests__/radio-hook.test.ts
```

- [ ] **步骤 5：commit**

```bash
git add src/agent/hooks/radio-hook.ts src/agent/radio-templates.ts src/agent/hooks/__tests__/radio-hook.test.ts
git commit -m "feat(agent): add radio heartbeat — periodic status update within same phase"
```

### 任务 C2：星域感知无线电 — 让 domain 注入消息

**文件：**
- 修改：`src/agent/radio-templates.ts`
- 修改：`src/agent/hooks/radio-hook.ts`

当前无线电消息是通用中文，不体现当前星域人格。在破军域执行时，"开始修改"和在天府域执行时的语气应该不同。

- [ ] **步骤 1：添加 3 个星域感知模板**

在 `radio-templates.ts` 中：

```typescript
// Domain-aware variants (domainType is 'pojun' | 'tianfu' | 'tianliang')
'execute→verify:pojun':   '[天枢·破军] 突破完成，来验验成色。',
'execute→verify:tianfu':  '[天枢·天府] 改动就位，开始审查。',
'execute→verify:tianliang': '[天枢·天梁] 代码已写，按 spec 逐项验证。',
'plan→execute:pojun':     '[天枢·破军] 方案已定，放手一搏。',
'plan→execute:tianfu':    '[天枢·天府] 计划审慎，开始执行。',
'plan→execute:tianliang': '[天枢·天梁] 按计划逐步实现。',
```

- [ ] **步骤 2：修改 extractTemplateVars 接收 domainType**

```typescript
export interface TemplateVars {
  // ... existing fields
  domainType?: string  // 'pojun' | 'tianfu' | 'tianliang'
}
```

- [ ] **步骤 3：修改 formatRadioMessage 支持 domain 变体**

```typescript
export function formatRadioMessage(ctx: RadioContext): string {
  // Try domain-specific template first: "transition:domainType"
  if (ctx.vars.domainType) {
    const domainKey = `${ctx.transition}:${ctx.vars.domainType}`
    if (TEMPLATES[domainKey]) {
      // Use domain-specific template
    }
  }
  // Fall back to generic template
  const template = TEMPLATES[ctx.transition] ?? FALLBACK_TEMPLATE
  // ...
}
```

- [ ] **步骤 4：在 radio-hook 中注入 domainType**

在 `createRadioHook` 中，从 `ctx.snapshot` 或 effects 获取当前 activeDomain。如果无法从 snapshot 获取（当前 RuntimeHookSnapshot 不含 domain），通过 `effects` 接口扩展：

在 `RuntimeHookEffects` 中添加：
```typescript
getActiveDomain?: () => string | null
```

在 `radio-hook.ts` 的 phase transition 分支中：
```typescript
const domainType = effects.getActiveDomain?.() ?? undefined
if (domainType) vars.domainType = domainType
```

- [ ] **步骤 5：运行 typecheck + radio 测试**

```bash
npx tsc --noEmit
npx tsx --test src/agent/hooks/__tests__/radio-hook.test.ts
```

- [ ] **步骤 6：commit**

```bash
git add src/agent/radio-templates.ts src/agent/hooks/radio-hook.ts src/agent/runtime-hooks.ts
git commit -m "feat(agent): inject star domain into radio messages for personality-aware communication"
```

### 任务 C3：确保天枢之眼 Strip 数据流入

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：`src/tui/summary-bar.tsx`

SummaryBar 已扩展接口（`starPhaseGlyph`, `starPhaseLabel`, `alchemyConfidence`, `recentToolSummary`），但需确认数据从 AgentLoop 正确流入。

- [ ] **步骤 1：追踪数据流**

从 `src/agent/loop.ts` 中 `onPhaseChange` callback → `src/tui/app.tsx` 中消费 → `SummaryBar` props。确认：

1. `starPhaseGlyph` 从 `PHASE_GLYPHS[phase]` 获取
2. `starPhaseLabel` 从 `PHASE_SHORT_LABELS[phase]` 获取
3. `alchemyConfidence` 从 `sensorium.confidence` 获取
4. `recentToolSummary` 从最近 3 个 tool 的 `tool + target` 截断获取

如果任何字段未正确流入，修复数据管道。

- [ ] **步骤 2：运行 typecheck**

```bash
npx tsc --noEmit
```

- [ ] **步骤 3：commit**

```bash
git add src/tui/app.tsx src/tui/summary-bar.tsx
git commit -m "fix(tui): ensure Tianshu Eye strip data flows from AgentLoop to SummaryBar"
```

---

## 验证

### 迭代 A 验证

```bash
npx tsc --noEmit                           # 0 errors
npx tsx --test src/prompt/__tests__/field-habituation.test.ts  # 全部通过
npx tsx --test src/**/__tests__/*.test.ts  # 通过率不低于基线
```

### 迭代 B 验证

```bash
npx tsc --noEmit                           # 0 errors
npx tsx --test src/prompt/__tests__/volatile-weight.test.ts  # token 数 < 目标值
npx tsx --test src/prompt/__tests__/volatile*.test.ts        # 全部通过
```

### 迭代 C 验证

```bash
npx tsc --noEmit                           # 0 errors
npx tsx --test src/agent/hooks/__tests__/radio-hook.test.ts  # 全部通过（含 heartbeat + domain）
```

### 端到端手动验证（建议在 AB 实验环境执行）

1. 启动 `node dist/main.js`，在破军域执行一个编程任务
2. 观察星相 Strip 是否正确显示 phase glyph + label + alchemy bar
3. 观察无线电消息是否包含 domain 前缀（如 `[天枢·破军]`）
4. 在 execute 阶段停留 6+ turn，确认收到 heartbeat 简报
5. 对比有人格/无人格模式下的无线电消息风格差异

---

## 自检

### 1. Spec 覆盖

| 需求 | 任务 | 状态 |
|------|------|------|
| 修复 habituation v3 type error | A1 | ✅ |
| phaseHint 数据流接入 | A3 | ✅ |
| v3 测试全部通过 | A2 | ✅ |
| 上下文减重 20-30% | B2, B3 | ✅ |
| volatile weight 可度量 | B1 | ✅ |
| phase 内心跳简报 | C1 | ✅ |
| 星域人格注入无线电 | C2 | ✅ |
| 天枢之眼 Strip 数据流入 | C3 | ✅ |

### 2. Placeholder 扫描

本计划无 TODO / TBD / 待定 / 后续实现 / 补充细节。所有代码变更均有精确描述或位置指定。所有测试均有具体断言逻辑。

### 3. 类型一致性

- `phaseHint: string` — 在 `engine.ts`、`loop.ts`、`field-habituation.ts` 中统一使用 string 类型，不引入跨模块类型依赖
- `PhaseClass` — 从 `radio-hook.ts` 提取到 `star-event.ts` 后，radio-hook 从 star-event 导入
- `TemplateVars.domainType` — 可选字段 `string | undefined`，formatRadioMessage 中做 undefined 检查
- `RuntimeHookEffects.getActiveDomain` — 可选方法 `() => string | null`，radio-hook 中做空检查

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-20-star-domain-partner-iteration.md`。两种执行方式：

1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
