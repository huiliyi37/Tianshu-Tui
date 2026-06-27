# Spec-to-Execute Verification Gate 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现。

**目标：** 当 agent 收到诊断文档（handoff / spec / issue report 含根因+修法+涉及文件）后，在首次编辑代码前强制注入验证提醒——如果没有独立验证步骤（读原始日志、写复现测试、运行已有测试），agent 会在编辑前看到门禁提示。

**架构：** 新增一个 `preTurn` runtime hook，在每轮开始前检查 `recentToolHistory` 中是否包含"读 spec 文档 → 读源文件 → 零验证"的模式。命中时通过 `advisoryBus` 注入一条 `constitutional` tier 的劝导条目——constitutional tier 保证它不被渲染上限截断。检测逻辑复用 `self-verify-hook.ts` 已有的 `isVerifyCall` 函数作为"什么是验证操作"的单一来源。同时新增一个探索性 P2 任务——post-commit 死代码检测（新增 public 符号但无生产调用点）——先做 AST 探针验证可行性再决定落地。

**技术栈：** TypeScript (strict)，`node:test` + `node:assert/strict`，现有 `RuntimeHookPipeline` + `AdvisoryBus` 基础设施。`volatile.ts` 中 `ToolHistoryEntry.target: string`（非 optional）。

---

## Diagnosis

### Current symptoms

- **Symptom A**: Agent 收到诊断文档（包含 根因/修法/涉及文件 三要素的结构化 spec）后，直接进入实现，跳过独立验证。
  - Evidence: `f64f47b6` commit — agent read `docs/handoff-goal-interrupt-issue.md` → read 4 source files → `edit_file` (reliability-mode.ts)，中间无 `run_tests`、无 `grep __tests__/`、无 `related_tests`、无日志数据查询。
  - Evidence: 后续讨论确认 pause/resume 机制未接到生产路径，且原始日志数据推翻了一开始的推理假设。

- **Symptom B**: Agent 在推理中引用来自诊断文档的数值声明（如 "4-54s 轮间间隔"）作为设计决策依据，但未对原始数据做独立查询。
  - Evidence: 讨论中 agent 承认 cache-log 数据显示 Turn 91: 383.7s 与文档中的 "54s" 矛盾，但首次实现时未交叉验证。

### Root cause

诊断文档的结构完整性触发了 agent 的"执行模式"而非"验证模式"。当文档同时包含根因分析、建议修法和涉及文件清单时，agent 将其归类为"待执行的实现 spec"而非"待验证的诊断假说"。这是跨 agent 的通病——与具体项目和 prompt 无关。

---

## 改动设计

### 注入点：`preTurn` runtime hook

选择 `preTurn` 而非 `postTool` 或工具级拦截，原因：
- `preTurn` 在每轮开始时触发，此时 `recentToolHistory` 已包含上一轮的全部工具调用
- 不影响工具执行流水线的性能
- 使用现有的 `AdvisoryBus` 基础设施，零新增依赖
- `constitutional` tier 保证即使 agent 有 3 条其他 advisory，这一条也不会被丢弃

### 检测模式

`recentToolHistory`（类型来源 `volatile.ts:ToolHistoryEntry`，`target: string` 必选，可为空串 `""`）：

```
recentToolHistory 中存在：
  1. read_file 的 target 匹配 spec 文档模式（glob 语义，匹配 docs/ 根目录下的 handoff/issue 文档）
  2. 随后 read_file(src/**) 或 grep(src/**)                            ← 源文件调研
  3. **不存在** run_tests 调用                                         ← 无测试运行
  4. **不存在** read_file 的 target 匹配 *.test.* 的文件               ← 无测试文件读取
  5. **不存在** read_file 或 bash 的 target 含 .rivet/sessions/ 路径   ← 无日志数据查询
```

验证操作的判定复用 `self-verify-hook.ts` 导出的 `isVerifyCall` 函数——保持"什么是验证"的单一定义源。

spec 文档模式用简单 glob 语义：`target.startsWith('docs/') && (target.includes('/handoff') || target.includes('-issue'))`，默认值 `docs/*handoff*,docs/*-issue*`。限制在 `docs/` 根目录避免误匹配 `docs/design/`、`docs/research/` 等子目录的分析文档。模式可通过 `SpecVerifyGateInput.specGlobs` 配置。

#### 关于 grep target 的重要说明

`grep` 工具的 `target` 字段存的是搜索 **pattern**（如 `setActiveDomain`），不是文件路径。因此检测 `grep(*.test.*)` 来判断"是否读了测试文件"在实践中不可能命中——没有人会 literally grep `*.test.*` 这个字符串。已从检测条件中移除。测试文件验证仅通过 `read_file(*.test.*)` 检测。

#### 关于 bash 日志验证的补充

`bash` 的 `target` 是完整命令文本，路径匹配 `.rivet/sessions/` 可以检测 `cat/head` 等命令。同时 `read_file` 也能直接读取 session JSONL——`read_file` 的 `target` 含 `.rivet/sessions/` 路径同样视为日志验证。两者同等对待。

模式命中时注入一条 constitutional advisory，附带 spec 文档路径：

> ⚠ 你刚读完 `{specDocPath}` 但尚未独立验证。先做以下至少一项再动手编辑代码：
> 1. 读原始运行时数据（日志、session JSONL、cache-log）交叉验证文档中的数值声明
> 2. 写一个复现测试看到 RED，确认缺陷确实存在
> 3. 运行已有测试确认当前 baseline 是绿的
>
> 诊断文档是假说，不是 spec。验证之后再实现。

### 审查门（post-commit dead code detection）— P2 探索性

在 `deliver_task` 流程中新增一个检查：对本次 commit 新增的 `export function` / public method，用 TypeScript AST 解析提取符号，然后 grep 确认测试文件外至少有一个生产调用点。零调用点 → YELLOW gate。

**可行性风险**（来自 review）：
- `export function` 有多种语法形式（`export async function`、`export const fn =`、`export default function`、`export { fn }`），正则匹配不可靠——必须用 AST
- grep 调用点容易命中测试文件、自身文件、注释/字符串中的引用
- 隐式调用（如 `this.paused` 内部状态而非显式 `pause()`）grep 会漏

**执行策略**：先做 30 秒 AST 探针验证可行性（读 ts-morph 或直接用 tsc API 提取导出符号），再决定是否落地。不阻塞主任务 1-4 的交付。

---

## 先例引用

- `src/agent/hooks/self-verify-hook.ts` — 已有的 postTurn hook，检测"最近全部是读操作且无 ground-truth 验证"，注入 advisory。本 gate 是它的 preTurn 前置版本，检测更具体的"spec→实现"跳跃。**本 gate 复用其 `isVerifyCall` 函数。**
- `src/agent/advisory-bus.ts` — 已有的 advisory 汇聚器，支持 constitutional tier（永不被截断）。本 gate 使用 constitutional tier。
- `src/prompt/volatile.ts:115` — `ToolHistoryEntry.target: string`（必选，非 optional）。spec-verify-gate 的输入类型与此对齐。

---

## 测试反证表

| 场景 | 预期行为 | 反证：如何让测试失败 |
|------|---------|---------------------|
| 读 spec → 读源码 → 直接 edit | 注入 constitutional advisory | 若 history 含此模式但 advisory 未注入 → 失败 |
| 读 spec → 运行 run_tests → edit | 不注入 advisory | 若错误注入 → 失败 |
| 读 spec → read_file(.rivet/sessions/xxx.jsonl) → edit | 不注入 advisory | 若错误注入 → 失败 |
| 读 spec → bash(cat .rivet/sessions/xxx.jsonl) → edit | 不注入 advisory | 若错误注入 → 失败 |
| 读 spec → read_file(src/foo.test.ts) → edit | 不注入 advisory | 若错误注入 → 失败 |
| 无 spec 文档，正常开发流程 | 不注入 advisory | 若错误注入 → 失败 |
| 读 `docs/design/*handoff*`（子目录） | 不注入（glob 限定 docs/ 根目录） | 若错误注入 → 失败 |

---

## 执行次序

### 任务 1：导出 `isVerifyCall` 为公共函数

**修改** `src/agent/hooks/self-verify-hook.ts`

将 `isVerifyCall` 和 `VERIFY_BASH_RE` 从模块私有改为 `export`。

验证：`npx tsc --noEmit`（确认导出不破坏现有引用）

### 任务 2：定义检测逻辑（纯函数，独立可测）

**新建** `src/agent/hooks/spec-verify-gate.ts`

```typescript
import { isVerifyCall } from './self-verify-hook.js'

export interface SpecVerifyGateInput {
  /** 最近 N 条工具历史。target 为 string（必选，来自 ToolHistoryEntry），空串表示无 target。 */
  recentToolHistory: Array<{ tool: string; target: string }>
  /** spec 文档的 glob 模式（简单 prefix+contains 语义），默认 ['docs/*handoff*', 'docs/*-issue*'] */
  specGlobs?: string[]
  /** spec 文档的窗口大小（最近多少条工具中查找），默认 20 */
  windowSize?: number
}

export interface SpecVerifyGateResult {
  /** 是否检测到"spec→实现"跳跃模式 */
  triggered: boolean
  /** 检测到的 spec 文档路径（用于 advisory 消息） */
  specDocPath?: string
  /** 缺失的验证类型列表 */
  missingVerifications: string[]
}

export function detectSpecToExecuteJump(input: SpecVerifyGateInput): SpecVerifyGateResult
```

检测逻辑（逐条对应上方的检测模式 1-5）：

1. 在 `recentToolHistory` 最后 `windowSize` 条中向前扫描，找第一条匹配 spec glob 的 `read_file`（`tool === 'read_file'`）
2. 从该位置到末尾，检查 `isVerifyCall(h)` 是否为 true（复用 self-verify-hook 的定义）
3. 检查 `read_file` 的 `target` 是否匹配 `*.test.*`（测试文件读取）
4. 检查 `read_file` 或 `bash` 的 `target` 是否含 `.rivet/sessions/`（日志数据查询）
5. 若以上验证步骤（2-4）全部未命中且有一条以上源文件 read → `triggered = true`

spec glob 匹配逻辑：`target.startsWith('docs/') && (target.includes('/handoff') || target.includes('-issue'))`

**测试文件** `src/agent/__tests__/spec-verify-gate.test.ts`

TDD 步骤：
1. 写测试：`read_file('docs/handoff-foo.md') → read_file('src/x.ts') → 无验证 → triggered=true`
2. 实现 `detectSpecToExecuteJump`
3. 写测试：`read_file('docs/handoff-foo.md') → run_tests → triggered=false`
4. 写测试：`read_file('docs/handoff-foo.md') → read_file('.rivet/sessions/x.jsonl') → triggered=false`
5. 写测试：`read_file('docs/handoff-foo.md') → bash('cat .rivet/sessions/x.jsonl') → triggered=false`
6. 写测试：`read_file('docs/handoff-foo.md') → read_file('src/foo.test.ts') → triggered=false`
7. 写测试：spec 在 window 外（前 25 条，windowSize=20）→ triggered=false
8. 写测试：只有 `read_file('src/x.ts')`，无 spec → triggered=false
9. 写测试：`read_file('docs/design/some-handoff-analysis.md')`（子目录）→ 不匹配 spec glob → triggered=false
10. 写测试：`modeForRecoveryTrigger` 空 target → 不崩溃

验证：`npx tsc --noEmit && npm exec -- tsx --test src/agent/__tests__/spec-verify-gate.test.ts`

### 任务 3：实现 preTurn hook

**新建** `src/agent/hooks/spec-verify-gate-hook.ts`

```typescript
import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { detectSpecToExecuteJump } from './spec-verify-gate.js'

export function createSpecVerifyGateHook(deps: {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'spec-verify-gate',
    run(ctx: RuntimeHookContext) {
      const result = detectSpecToExecuteJump({
        recentToolHistory: ctx.snapshot.recentToolHistory.map(h => ({
          tool: h.tool,
          target: h.target,  // string (非 optional) → 直接传递
        })),
      })
      if (result.triggered) {
        deps.advisoryBus.submit({
          key: 'spec-verify-gate',
          priority: 0.9,
          category: 'constitutional',
          tier: 'constitutional',
          content: `⚠ 你刚读完 \`${result.specDocPath ?? '一份诊断方案'}\` 但尚未独立验证。先做以下至少一项再动手编辑代码：
1. 读原始运行时数据（日志、session JSONL、cache-log）交叉验证文档中的数值声明
2. 写一个复现测试看到 RED，确认缺陷确实存在
3. 运行已有测试确认当前 baseline 是绿的

诊断文档是假说，不是 spec。验证之后再实现。`,
          ttl: 1,
        })
      }
    },
  }
}
```

**测试文件** `src/agent/__tests__/spec-verify-gate-hook.test.ts`

TDD 步骤：
1. 构造含 spec-read + source-read 无验证的 snapshot，确认 hook.run() 调用了 advisoryBus.submit 且 tier 为 'constitutional'
2. 构造含 `run_tests` 的 snapshot，确认 hook.run() 不调用 submit
3. 构造空 history，确认不调用 submit

验证：`npx tsc --noEmit && npm exec -- tsx --test src/agent/__tests__/spec-verify-gate-hook.test.ts`

### 任务 4：注册 hook

**修改** `src/agent/create-runtime-hooks.ts`

在 `createDefaultRuntimeHooks` 中，于现有 `self-verify` hook 附近添加：

```typescript
// Spec-verify gate: detect "read spec → implement without verification" jumps
if (deps.advisoryBus) {
  hooks.push(createSpecVerifyGateHook({ advisoryBus: deps.advisoryBus }))
}
```

验证：`npx tsc --noEmit`

### 任务 5：End-to-end 集成测试

**新建** `src/agent/__tests__/spec-verify-gate-integration.test.ts`

构造完整 RuntimeHookPipeline，注入 spec-verify-gate hook，用真实 snapshot 结构验证端到端行为。验证 advisory 确实被注入到 `<星域-advisory>` 块中，且 constitutional tier 条目不被截断。

验证：`npm exec -- tsx --test src/agent/__tests__/spec-verify-gate-integration.test.ts`

### 任务 6：审查门 — 死代码检测探针（P2，独立交付）

**不修改** `deliver-task.ts`，先在独立脚本中验证可行性。

**新建** `scripts/dead-export-check.ts`

30 秒探针：读取一个已知有 dead export 的 commit（如 `f64f47b6`），用 `npx tsc --listEmittedFiles` 或 `ts-morph` 提取新增导出符号，然后 grep 调用点。确认 AST-based 方法可行后再接入 `deliver_task`。

验证：`npx tsx scripts/dead-export-check.ts f64f47b6..f64f47b6~1`

---

## 设计决策记录

1. **选 preTurn 而非 postTool**：preTurn 的 snapshot 已有 `recentToolHistory`，不需要扩展接口。阅读 spec + 源码通常跨至少 2 个 turn。同 turn 内的 spec→edit 跳过快但极少发生。

2. **选 advisory 而非硬拦截**：硬拦截会让 agent 的修复工作流中断。advisory 在 turn 开始时注入，agent 读到后会自行调整——符合"提醒"而非"禁止"的语义。

3. **constitutional tier**：使用 constitutional tier，保证 advisory 在任意条件下都不会被 `MAX_ADVISORIES_PER_TURN=3` 截断。

4. **target: string 对齐实际类型**：`ToolHistoryEntry.target` 是 `string`（非 optional），`SpecVerifyGateInput.recentToolHistory` 对齐此类型。空串表示无 target。

5. **spec 文档 glob 限制 docs/ 根目录**：使用 `target.startsWith('docs/') && target.includes('/handoff')` 语义，`docs/design/*handoff*` 等子目录不匹配。

6. **复用 isVerifyCall**：从 `self-verify-hook.ts` 导出 `isVerifyCall`，`spec-verify-gate.ts` 直接引用——保持"什么是验证操作"的单一来源。

7. **grep(*.test.*) 已移除**：grep 的 target 是 search pattern 而非文件路径，匹配 `*.test.*` 无意义。

8. **advisory 注入 spec 文档路径**：`specDocPath` 在 advisory 文本中渲染，帮助 agent 定位漏验证的具体文档。

---

## 验证清单

- [ ] `isVerifyCall` 从 self-verify-hook 正确导出，不破坏现有测试
- [ ] `detectSpecToExecuteJump` 纯函数：10 个场景全部覆盖
- [ ] hook 测试：advisory 注入/不注入两个路径，tier 确认为 constitutional
- [ ] 集成测试：端到端 pipeline → advisory 渲染
- [ ] typecheck 全绿
- [ ] 现有测试无回归：`npm exec -- tsx --test src/agent/__tests__/spec-verify-gate*.test.ts src/agent/__tests__/self-verify*.test.ts`
- [ ] constitutional tier advisory 在 3 条现有 advisory 满槽时仍被渲染
- [ ] Task 6 探针：AST 提取新增导出符号可行性确认

---

计划已完成并保存到 `docs/superpowers/plans/2026-06-24-spec-to-execute-verification-gate.md`。两种执行方式：
1. 子代理驱动（推荐）——任务 1-4 可串行，任务 6 独立于主路径
2. 内联执行（使用 executing-plans）
选哪种方式？
