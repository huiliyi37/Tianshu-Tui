# B1 Ownership Delivery Gate 减压修正计划

> **定位：** B1 归属星轨的体验层/交付门减压修正。  
> **目标：** 保留现有 ownership 安全能力，不回滚 B1；将“强阻断型安全”调整为“当前改动强保护 + 历史/外部 caveat”的天枢协作模型。  
> **触发：** 天枢 TUI 实际运行体验显示，外部模型基于 Claude Code / Opus 的感受设计出的强阻断策略，在天枢 TUI 中会造成过度 RED、假阻断、状态焦虑与能力降级。

---

## 0. 核心判断

B1 的方向是正确的：

- shared worktree 必须区分 owned / external；
- 写操作必须能实时进入 ownership；
- 验证结果必须进入 ledger；
- 交付前必须有结构化报告。

但当前实现有一处体验失衡：

> **它把“历史 owned + 当前 dirty + 全量失败 + 外部 dirty + 归因不明”混进同一个 RED 交付门。**

这会让 agent 在真实任务已提交、当前工作区只剩外部 dirty 时，仍然看到：

```text
Delivery Gate: RED
Owned files: 14
Blocking: Owned verification failed
```

而真实 `git status` 可能只有：

```text
M .gitignore
M .rivet/knowledge/project-memory.md
```

这种 RED 不是安全，而是陈旧状态造成的假阻断。它会降低 agent 的行动能力，让 agent 反复解释、犹豫、误以为自己仍未交付。

---

## 1. 设计原则

### 1.1 不推翻 B1

本计划不是 revert：

- 保留 `ownershipLedger.registerOwned()` 实时注册；
- 保留 `autoOwnFromLedger()` 作为兜底；
- 保留 verification regex 对 `build/lint/check/test/tsc` 的覆盖；
- 保留 deliver_task 的结构化报告。

### 1.2 只降低误伤阻断

强阻断只适用于：

> 当前任务仍有未提交的 owned dirty 文件，并且这些当前改动未验证或验证失败。

不应强阻断：

- 已提交的历史 owned 文件；
- 外部 dirty 文件；
- 无失败文件归因的全量测试失败；
- deliver_task 成功生成的 RED/YELLOW 报告本身。

### 1.3 诊断状态不是工具错误

`deliver_task` 生成 RED 报告，不等于工具执行失败。

- 工具失败：B1 context 缺失、内部异常、commit 参数缺失等。
- 工程 RED：交付门诊断结果，应作为内容返回，不应污染 tool error / mistake history。

### 1.4 天枢 TUI 体验优先

外部模型的设计可能更偏向 Claude Code 的“一次性强工具闸门”。天枢 TUI 的协作体验更接近持续会话、共享工作区、长期 ledger，因此需要：

- 分层；
- 可解释；
- 不把历史状态当当前阻断；
- 不让 agent 因假 RED 降级。

---

## 2. 当前问题定位

### 2.1 实时 ownership 本身合理

当前实现：

```ts
// src/agent/tool-pipeline.ts
deps.taskLedger.record({ type: 'file_write', path: filePath })
deps.ownershipLedger?.registerOwned(filePath)
```

这解决了“写了文件但 deliver_task 前 ownership 为空”的问题，应保留。

### 2.2 ledger 生命周期过长

`OwnershipLedger` 目前是内存 `Set`：

```ts
const ownedSet = new Set<string>()
```

问题：文件一旦 owned，不会因为以下事件自动退出当前交付门：

- 文件已 commit；
- 文件恢复 clean；
- 进入下一任务；
- 只剩 external dirty；
- 当前任务完成。

结果：历史 owned 会继续参与当前 delivery gate。

### 2.3 verification attribution 过硬

当前 `VerificationAttribution` 对失败的处理：

```ts
if (result.status === 'failed') {
  if (result.scope === 'targeted') return owned_failure
  return ambiguous
}
```

而 `DeliveryGateV2` 把 TaskLedger 中的 verification event 转成 `scope: 'targeted'`，但 TaskLedger 的 bash verification 只有 command/status，没有失败文件归因。

所以一个外部全量测试失败可能被压成 owned failure。

### 2.4 deliver_task RED 被标记为 ToolResult error

当前：

```ts
const isError = report.state === 'RED'
return { content: lines.join('\n'), isError }
```

这会把“成功生成交付诊断报告”记录成工具失败，制造错误的轨迹信号。

### 2.5 ownership health warning 文案过强

当前 warning：

```text
No owned files registered, but dirty files exist. Check task-ledger write events.
```

在 shared worktree 下，“当前任务没有 owned，但存在 external dirty”是正常状态，不应默认呈现为异常。

---

## 3. 目标状态

真实状态：

```text
当前任务已提交；工作区只剩外部 dirty；全量测试有一个已知外部失败。
```

期望 deliver_task：

```text
Delivery Gate: YELLOW
Current owned dirty files: 0
External dirty files: 2
Recently owned files: 14 (already clean/committed)
Known caveat: full-suite failure in src/config/__tests__/schema.test.ts, attribution unresolved/external
Can deliver current task: yes, with caveat
```

而不是：

```text
Delivery Gate: RED
Owned files: 14
Owned verification failed
```

---

## 4. 分层模型

### 4.1 Current Worktree Gate（强保护层）

只关注当前仍 dirty 的 owned 文件：

- 当前 owned dirty files；
- 当前 owned dirty files 是否有验证；
- 当前 owned dirty files 的 targeted verification 是否失败。

这一层可以 RED。

### 4.2 Session Ledger Summary（历史复盘层）

展示：

- 本会话曾经 owned 的文件；
- 已提交/已 clean 的 owned 文件；
- 跑过的验证；
- 失败过的验证。

这一层不直接阻断。

### 4.3 External Caveats（外部提示层）

展示：

- external dirty；
- full-suite failure；
- attribution unknown；
- pre-existing untracked/dirty。

这一层通常 YELLOW，不直接 RED。

---

## 5. 实施任务

### 任务 1：deliver_task RED 不再作为 ToolResult error

**文件：**

- `src/agent/deliver-task.ts`
- `src/agent/__tests__/deliver-task.test.ts`

**目标：** RED 是交付门状态，不是工具执行失败。

**修改：**

```ts
// Before
const isError = report.state === 'RED'
return { content: lines.join('\n'), isError }

// After
return { content: lines.join('\n') }
```

仅以下情况返回 `isError: true`：

- `commit=true` 且 gate RED，作为用户请求被拒绝；
- `commit=true` 且缺少 message；
- 内部异常。

**测试：**

- status-only RED report：`isError` 应为 false；
- commit=true + RED：`isError` 应为 true；
- report 内容仍包含 `Delivery Gate: RED` 和 blocking reason。

---

### 任务 2：DeliveryGate 只阻断 current dirty owned files

**文件：**

- `src/agent/delivery-gate-v2.ts`
- `src/agent/ownership-ledger.ts` 或新增辅助函数
- `src/agent/__tests__/delivery-gate-v2.test.ts`

**目标：** 已提交/clean 的 owned 文件不再参与当前阻断。

**设计：** 给 DeliveryGate 输入当前 dirty files，或让 OwnershipLedger 提供：

```ts
getCurrentOwnedDirtyFiles(currentDirtyFiles: string[]): string[]
```

当前 dirty 来源可以先由 deliver_task 调用 git 状态采集，后续再抽象。

**最低实现：**

- `DeliveryGateV2.getReport(externalVerifications, currentDirtyFiles?)`
- 若传入 `currentDirtyFiles`，则：
  - `ownedFilesForGate = ownership.getOwnedFiles() ∩ currentDirtyFiles`
  - `historicalOwnedFiles = ownership.getOwnedFiles() - ownedFilesForGate`
- gate RED 只依据 `ownedFilesForGate`。

**测试：**

- owned ledger 有文件，但 currentDirtyFiles 为空 → GREEN/YELLOW，不 RED；
- owned ledger 有文件，currentDirtyFiles 包含 owned，且无验证 → RED；
- external dirty 不进入 owned gate。

---

### 任务 3：full-scope failed verification 降级为 caveat，除非能归因到 owned

**文件：**

- `src/agent/verification-attribution.ts`
- `src/agent/__tests__/verification-attribution.test.ts`

**目标：** 没有失败文件归因时，全量测试失败不直接阻断当前 owned delivery。

**策略：**

- targeted failed → 可 RED；
- full failed + 无失败文件归因 → `external_blocked` 或新状态 `unattributed_failure`，delivery gate 显示 YELLOW；
- full failed + 明确失败文件属于 owned → RED；
- full failed + 明确失败文件属于 external → YELLOW。

**短期实现：** 在没有失败文件解析能力前：

```ts
full failed => ambiguous caveat, isBlocking: false
```

或新增：

```ts
type AttributionClass = ... | 'unattributed_failure'
```

**测试：**

- full failed 不再 aggregate 为 owned_failure；
- targeted failed 仍是 owned_failure；
- passed 仍 verified。

---

### 任务 4：ownership health warning 改成信息性 caveat

**文件：**

- `src/agent/ownership-health.ts`
- `src/agent/__tests__/ownership-health.test.ts`
- `src/agent/__tests__/deliver-task.test.ts`

**目标：** shared worktree 下外部 dirty 是正常状态，不制造误报焦虑。

**修改建议：**

当前：

```text
No owned files registered, but dirty files exist. Check task-ledger write events.
```

改为：

```text
No current owned dirty files. External dirty files are present and excluded from delivery scope.
```

或者只有当 dirty 文件既不 owned 也不 external 时才 warning。

**测试：**

- owned=0, external>0 → informational，不叫 warning；
- dirty 文件无法分类 → warning；
- owned dirty 存在 → 正常列出。

---

### 任务 5：deliver_task 报告分层显示

**文件：**

- `src/agent/deliver-task.ts`
- `src/agent/__tests__/deliver-task.test.ts`

**目标：** 输出结构更贴近天枢协作体验。

建议输出：

```text
Delivery Gate: YELLOW

Current owned dirty files (0):
  (none)

Historical owned files (14):
  ...

External dirty files (2):
  .gitignore
  .rivet/knowledge/project-memory.md

Verifications: 21
Caveats:
  Full-suite verification failed; attribution unresolved/external.

Can deliver current task: yes, with caveat.
```

---

## 6. 非目标

本计划不做：

- 不移除 B1；
- 不关闭 ownership；
- 不回滚实时 registerOwned；
- 不绕过交付门；
- 不让 `git add .` 变安全；
- 不修改 prompt cache 相关模块；
- 不用外部模型重新设计整套归属系统。

---

## 7. 验证计划

### 7.1 单元测试

```bash
./node_modules/.bin/tsx --test \
  src/agent/__tests__/deliver-task.test.ts \
  src/agent/__tests__/delivery-gate-v2.test.ts \
  src/agent/__tests__/verification-attribution.test.ts \
  src/agent/__tests__/ownership-health.test.ts
```

### 7.2 Typecheck

```bash
npx tsc --noEmit
```

### 7.3 体验回归场景

1. 修改并提交 owned 文件；
2. 工作区只剩 external dirty；
3. 全量测试有一个外部失败；
4. 调用 `deliver_task`。

期望：

- 不显示当前 owned dirty；
- 不 RED；
- 显示 YELLOW caveat；
- 不把 report 标为 ToolResult error。

---

## 8. 风险与护栏

### 风险 1：过度放松导致真实 owned failure 被放过

护栏：targeted verification failure 仍 RED；current owned dirty 未验证仍 RED。

### 风险 2：full-suite failure 被降级后隐藏真实回归

护栏：显示 YELLOW caveat；后续可增加失败文件解析，把失败归因到 owned 时再 RED。

### 风险 3：实现过大破坏现有 B1

护栏：按任务逐步提交，每步测试；优先任务 1 和 4，降低工具错误噪音和 warning 噪音；任务 2/3 再调整 gate 语义。

---

## 9. 推荐执行顺序

1. **任务 1：deliver_task RED 不作为 ToolResult error** — 最小、直接改善体验。
2. **任务 4：ownership health 文案降压** — 降低 shared worktree 正常状态的误报。
3. **任务 2：current dirty owned gate** — 解决已提交 owned 仍阻断。
4. **任务 3：full-suite failed 降级 caveat** — 解决外部全量失败误伤。
5. **任务 5：报告分层显示** — 最后做 UI/文案整理。

---

## 10. 完成定义

- 当前 clean/已提交 owned 文件不再造成 RED；
- external dirty 不造成 RED；
- full-suite 无归因失败不直接造成 owned_failure；
- deliver_task RED report 不作为工具执行错误；
- 所有 B1 相关测试通过；
- 保留原 B1 的核心安全能力：current owned dirty 未验证/失败仍阻断。
